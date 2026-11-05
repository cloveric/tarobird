import { test, expect, type Page } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HubServer } from "../../src/hub/server.js";
import { preparePairing } from "./fixtures/pairing-invite.js";
import { mobileChatAction, showDisconnectedBots, selectConversation, waitForClientOnline } from "./fixtures/mobile.js";

test("clear 2105 App records across devices while preserving the session, drafts and new messages after a lost receipt", async ({ browser }, info) => {
  test.setTimeout(240_000);
  const root = await mkdtemp(path.join(os.tmpdir(), "history-clear-ui-"));
  const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve("dist") });
  const phoneContext = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, serviceWorkers: "block" });
  const desktopContext = await browser.newContext({ viewport: { width: 1360, height: 900 }, serviceWorkers: "block" });
  const phone = await phoneContext.newPage(), desktop = await desktopContext.newPage(), errors: string[] = [];
  for (const page of [phone, desktop]) page.on("pageerror", error => errors.push(error.message));
  try {
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('bot','助手','fixture')");
    const chat = await hub.store.createConversation("owner", ["bot"], "清理记录验收", "history");
    await hub.store.db.run("UPDATE conversations SET session_id='preserved-native-session' WHERE id=?", [chat.id]);
    const ids: string[] = [];
    for (let n = 0; n < 2105; n++) ids.push((await hub.store.publishBotMessage("bot", { conversationId: chat.id, blocks: [{ type: "text", text: `历史 ${n} ${"内容".repeat(30)}` }] })).id);
    const pair = async (page: Page) => {
      await page.goto(hub.url); await preparePairing(page, hub); await page.getByRole("button", { name: "配对此设备", exact: true }).click();
      await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
      await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" }); await showDisconnectedBots(page); await waitForClientOnline(page); await selectConversation(page, chat.title);
      await expect(page.getByRole("progressbar", { name: /^同步历史/ })).toHaveCount(0, { timeout: 60_000 });
      await expect(page.locator(`article[data-message-id="${ids.at(-1)}"]`)).toBeVisible({ timeout: 30_000 });
    };
    await pair(phone); await pair(desktop);
    await desktopContext.setOffline(true);
    const composer = phone.getByRole("textbox", { name: "消息", exact: true }); await composer.fill("保留未发出的草稿");
    await phone.getByRole("button", { name: "查看对话详情", exact: true }).click();
    const directEntry = phone.getByRole("button", { name: "清理聊天记录", exact: true });
    await expect(directEntry).toHaveCount(1); await directEntry.click();
    const directConfirm = phone.getByRole("dialog", { name: "清理 2105 条聊天记录？", exact: true });
    await expect(directConfirm).toBeVisible(); await phone.keyboard.press("Escape");
    await expect(directConfirm).toHaveCount(0); await expect(directEntry).toBeFocused();
    await phone.getByRole("button", { name: "对话设置", exact: true }).click();
    const entry = phone.getByRole("button", { name: "清理聊天记录", exact: true }); await expect(entry).toBeEnabled(); await entry.click();
    const confirmation = phone.getByRole("dialog", { name: "清理 2105 条聊天记录？", exact: true });
    await expect(confirmation).toContainText("Bot 的会话和上下文保持不变"); await expect(confirmation).toContainText("其他成员不受影响");
    await confirmation.getByRole("button", { name: "关闭", exact: true }).click();
    expect((await hub.store.snapshot("owner", chat.id)).messages.filter(m => m.status === "deleted")).toHaveLength(0);
    await entry.click(); await expect(confirmation).toBeVisible();
    const later = await hub.store.publishBotMessage("bot", { conversationId: chat.id, blocks: [{ type: "text", text: "统计之后的新消息" }] });
    await phone.screenshot({ animations: "disabled", path: info.outputPath("phone-clear-confirm.png") });
    let calls = 0; const boundaries: string[] = [];
    await phone.route("**/api/conversations/*/messages/clear", async route => {
      if (route.request().method() !== "POST") return route.continue();
      calls++; boundaries.push(route.request().postDataJSON().throughId);
      if (calls === 2) {
        // The Host commits; the client never receives the successful receipt.
        await route.fetch(); return route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "receipt_lost" }) });
      }
      await route.continue();
    });
    await confirmation.getByRole("button", { name: "清理记录", exact: true }).click();
    await expect(confirmation.getByRole("alert")).toContainText("清理未完成", { timeout: 30_000 });
    expect((await hub.store.snapshot("owner", chat.id)).messages.filter(m => m.status === "deleted")).toHaveLength(200);
    await expect(confirmation).toContainText("已清理 100 / 2105 条");
    await phone.screenshot({ animations: "disabled", path: info.outputPath("phone-clear-retry.png") });
    const newest = await hub.store.publishBotMessage("bot", { conversationId: chat.id, blocks: [{ type: "text", text: "重试之前的新消息" }] });
    await confirmation.getByRole("button", { name: "继续清理", exact: true }).click();
    await expect(confirmation).toHaveCount(0, { timeout: 90_000 });
    await expect(phone.getByText("聊天记录已清理，Bot 上下文保持不变。", { exact: true })).toBeVisible();
    expect(new Set(boundaries)).toEqual(new Set([ids.at(-1)])); expect(calls).toBe(22);
    await phone.getByRole("button", { name: "关闭对话设置", exact: true }).click();
    await expect(composer).toHaveValue("保留未发出的草稿");
    await desktopContext.setOffline(false); await desktop.reload(); await waitForClientOnline(desktop); await selectConversation(desktop, chat.title);
    await expect(desktop.getByRole("progressbar", { name: /^同步历史/ })).toHaveCount(0, { timeout: 60_000 });
    for (const page of [phone, desktop]) {
      await expect(page.locator(`article[data-message-id="${ids.at(-1)}"]`)).toHaveCount(0);
      await expect(page.locator(`article[data-message-id="${later.id}"]`)).toBeVisible();
      await expect(page.locator(`article[data-message-id="${newest.id}"]`)).toBeVisible();
    }
    await desktop.screenshot({ animations: "disabled", path: info.outputPath("desktop-after-clear.png") });
    const snapshot = await hub.store.snapshot("owner", chat.id);
    expect(snapshot.conversation.sessionId).toBe("preserved-native-session");
    expect(snapshot.messages.filter(m => m.status !== "deleted").map(m => m.id)).toEqual([later.id, newest.id]);
    expect((await hub.store.messageForBot("bot", ids[0]!)).blocks).not.toEqual([]);
    expect(errors).toEqual([]);
  } finally { await phoneContext.close(); await desktopContext.close(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});
