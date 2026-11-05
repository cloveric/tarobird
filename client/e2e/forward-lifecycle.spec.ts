import { preparePairing } from "./fixtures/pairing-invite.js";
import { expect, test, type Page } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HubServer } from "../../src/hub/server.js";
import { messageAction } from "./fixtures/message-actions.js";
import { showDisconnectedBots, selectConversation, waitForClientOnline } from "./fixtures/mobile.js";

async function pair(page: Page, hub: HubServer) {
  await page.goto(hub.url);
  await preparePairing(page, hub); await page.getByRole("button", { name: "配对此设备", exact: true }).click();
  await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
  await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" }); await showDisconnectedBots(page);
  await waitForClientOnline(page);
}

for (const width of [1360, 390]) {
  test(`forward picker hides source updates and cannot submit a deleted message (${width}px)`, async ({ browser }) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "forward-source-"));
    const hub = await HubServer.start({ stateDir: root, clientDir: process.env.TAROBOT_TEST_CLIENT_DIR ?? path.resolve("dist") });
    const context = await browser.newContext({ viewport: { width, height: 844 } }), page = await context.newPage();
    try {
      await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','研究助手','fixture')");
      const source = await hub.store.createConversation("owner", ["alpha"], "来源对话", "source");
      const target = await hub.store.createConversation("owner", ["alpha"], "目标对话", "target");
      const message = await hub.store.publishBotMessage("alpha", { conversationId: source.id, blocks: [{ type: "text", text: "初始内容" }] });
      await pair(page, hub); await selectConversation(page, source.title);
      await messageAction(page, page.locator(`[data-message-id="${message.id}"]`), "转发消息");
      const dialog = page.getByRole("dialog", { name: "转发消息", exact: true });
      await dialog.getByRole("button", { name: target.title, exact: true }).click();
      await hub.store.publishBotMessage("alpha", { id: message.id, conversationId: source.id, blocks: [{ type: "text", text: "修订后的内容" }] });
      await expect(dialog.locator(".forward-preview, .rich-message-preview")).toHaveCount(0);
      await expect(dialog).not.toContainText("初始内容");
      await expect(dialog).not.toContainText("修订后的内容");
      await hub.store.publishBotMessage("alpha", { id: message.id, conversationId: source.id, blocks: [], status: "deleted" });
      // Personal deletion retires the source and closes its stale forward UI.
      await expect(dialog).toHaveCount(0);
      await expect(page.locator(`[data-message-id="${message.id}"]`)).toHaveCount(0);
      expect((await hub.store.snapshot("owner", target.id)).messages).toHaveLength(0);
      await expect(page.getByRole("textbox", { name: "消息", exact: true })).toBeVisible();
    } finally { await context.close(); await hub.close(); await rm(root, { recursive: true, force: true }); }
  });

  test(`forward recipients must be chosen again after removal on another device (${width}px)`, async ({ browser }) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "forward-members-"));
    const hub = await HubServer.start({ stateDir: root, clientDir: process.env.TAROBOT_TEST_CLIENT_DIR ?? path.resolve("dist") });
    const context = await browser.newContext({ viewport: { width, height: 844 } }), page = await context.newPage();
    const second = await browser.newContext({ viewport: { width: 1360, height: 844 } }), editor = await second.newPage();
    try {
      await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','研究助手','fixture'),('beta','写作助手','fixture')");
      const source = await hub.store.createConversation("owner", ["alpha"], "来源对话", "source");
      const group = await hub.store.createConversation("owner", ["alpha", "beta"], "目标群组", "target", { type: "group" });
      const message = await hub.store.publishBotMessage("alpha", { conversationId: source.id, blocks: [{ type: "text", text: "交给所选 Bot 处理" }] });
      await pair(page, hub); await selectConversation(page, source.title); await pair(editor, hub);
      await messageAction(page, page.locator(`[data-message-id="${message.id}"]`), "转发消息");
      const dialog = page.getByRole("dialog", { name: "转发消息", exact: true });
      await dialog.getByRole("button", { name: group.title, exact: true }).click();
      await dialog.getByRole("checkbox", { name: "让 Bot 回复这条转发", exact: true }).check();
      await expect(dialog.getByRole("checkbox", { name: "研究助手", exact: true })).toBeChecked();
      await editor.locator(".group-tree-heading .conversation-row").click({ button: "right" });
      await editor.getByRole("menuitem", { name: "群组设置", exact: true }).click();
      const settings = editor.getByRole("dialog", { name: "群组设置", exact: true });
      await settings.getByRole("checkbox", { name: "研究助手", exact: true }).uncheck();
      await settings.getByRole("button", { name: "保存", exact: true }).click();
      await expect(settings).toHaveCount(0);
      await expect(dialog.getByRole("checkbox", { name: "研究助手", exact: true })).toHaveCount(0);
      await expect(dialog.getByRole("button", { name: "确认转发", exact: true })).toBeDisabled();
      await dialog.getByRole("checkbox", { name: "写作助手", exact: true }).check();
      await dialog.getByRole("button", { name: "确认转发", exact: true }).click();
      await expect(dialog).toHaveCount(0);
      await expect.poll(async () => (await hub.store.snapshot("owner", group.id)).messages.length).toBe(1);
      const forwarded = (await hub.store.snapshot("owner", group.id)).messages[0]!;
      expect(forwarded.mentions).toEqual(["beta"]);
      expect((await hub.store.pendingForBot("alpha")).some(item => item.id === forwarded.id)).toBe(false);
      expect((await hub.store.pendingForBot("beta")).some(item => item.id === forwarded.id)).toBe(true);
    } finally { await context.close(); await second.close(); await hub.close(); await rm(root, { recursive: true, force: true }); }
  });
}
