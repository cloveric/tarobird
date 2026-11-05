import { preparePairing } from "./fixtures/pairing-invite.js";
import { showDisconnectedBots, enterMobileChat } from "./fixtures/mobile.js";
import { waitForClientOnline } from "./fixtures/mobile.js";
import { test, expect, type Page } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HubServer } from "../../src/hub/server.js";

async function pair(page: Page, hub: HubServer) {
  await page.goto(hub.url); await preparePairing(page, hub); await page.getByRole("button", { name: "配对此设备", exact: true }).click();
  await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
  await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" }); await showDisconnectedBots(page);
  await waitForClientOnline(page);
}
test("interrupted cards close on both devices and retain readable content after reload", async ({ browser }, info) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "worker-recovery-ui-"));
  const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve("dist") });
  const desktopContext = await browser.newContext({ viewport: { width: 1360, height: 900 } });
  const phoneContext = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const desktop = await desktopContext.newPage(), phone = await phoneContext.newPage();
  try {
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','研究助手','fixture')");
    const c = await hub.store.createConversation("owner", ["alpha"], "中断后继续工作", "recovery");
    const { message: input } = await hub.store.sendMessage("owner", { conversationId: c.id, clientMsgId: "input", text: "请整理这份报告", attachments: [] });
    const card = await hub.store.publishBotMessage("alpha", { conversationId: c.id, replyTo: input.id, status: "streaming", blocks: [{ type: "card", title: "报告整理", elements: [{ type: "markdown", text: "已经完成的分析内容" }, { type: "button", text: "允许继续", actionId: "allow" }] }] });
    for (const page of [desktop, phone]) { await pair(page, hub); await enterMobileChat(page, c.title); await expect(page.getByRole("button", { name: "允许继续", exact: true })).toBeEnabled(); }
    await hub.store.failDelivery("alpha", input.id, "interrupted");
    const notice = "处理因实例重启而中断，以上内容已保留，待确认操作已关闭。";
    for (const [page, device] of [[desktop, "desktop"], [phone, "phone"]] as const) {
      const message = page.locator(`[data-message-id="${card.id}"]`);
      await expect(message.getByText("处理已中断", { exact: true })).toBeVisible();
      await expect(message.getByText(notice, { exact: true })).toHaveCount(1);
      await expect(message.getByText("已经完成的分析内容", { exact: true })).toBeHidden();
      await message.getByText("中断前：报告整理", { exact: true }).click();
      await expect(message.getByText("已经完成的分析内容", { exact: true })).toBeVisible();
      await expect(message.getByRole("button", { name: "允许继续", exact: true })).toBeDisabled();
      await page.reload(); await waitForClientOnline(page); await enterMobileChat(page, c.title);
      await expect(message.getByText("处理已中断", { exact: true })).toBeVisible();
      await page.screenshot({ path: info.outputPath(`worker-recovery-${device}.png`) });
    }
  } finally { await desktopContext.close(); await phoneContext.close(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});
