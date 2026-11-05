import { expectSettingsPage } from "./fixtures/settings-page.js";
import { preparePairing } from "./fixtures/pairing-invite.js";
import { test, expect, type Page } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HubServer } from "../../src/hub/server.js";
import { selectConversation, showDisconnectedBots } from "./fixtures/mobile.js";

test.use({ serviceWorkers: "block", viewport: { width: 390, height: 640 }, isMobile: true, hasTouch: true });

async function pair(page: Page, hub: HubServer) {
  await page.goto(hub.url); await preparePairing(page, hub); await page.getByRole("button", { name: "配对此设备", exact: true }).click();
  await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
  await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" }); await showDisconnectedBots(page);
}

// The full page keeps navigation outside the scrollport and Save clear of
// the OS gesture area while the form scrolls.
test("phone group settings keep the title and Save clear of the page edges and home indicator", async ({ page }, info) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "group-settings-phone-"));
  const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve("dist") });
  try {
    const bots = Array.from({ length: 10 }, (_, i) => `('bot${i}','群成员助手${i}','fixture')`).join(",");
    await hub.store.db.run(`INSERT INTO bots(id,name,secret_hash) VALUES${bots}`);
    const group = await hub.store.createConversation("owner", ["bot0", "bot1", "bot2"], "安全区验收群", "phone-group", { type: "group" });
    await pair(page, hub); await selectConversation(page, group.title);
    await page.evaluate(() => {
      document.documentElement.style.setProperty("--safe-area-inset-top", "59px");
      document.documentElement.style.setProperty("--safe-area-inset-bottom", "34px");
    });
    await page.getByRole("button", { name: "更多聊天操作", exact: true }).click();
    await page.getByRole("button", { name: "对话详情", exact: true }).click();
    await page.getByRole("button", { name: "群组设置", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "群组设置", exact: true });
    await expect(dialog.getByRole("button", { name: "保存", exact: true })).toBeVisible();
    await expectSettingsPage(dialog, 390, 640);
    await dialog.evaluate((node: HTMLElement) => Promise.all(node.getAnimations({ subtree: true }).map(animation => animation.finished)));
    const geometry = () => dialog.evaluate((node: HTMLElement) => {
      const box = node.getBoundingClientRect(), header = node.querySelector(":scope > header")!.getBoundingClientRect();
      const title = node.querySelector(":scope > header h2")!.getBoundingClientRect();
      const actions = node.querySelector("form > .rename-conversation-actions")!.getBoundingClientRect();
      const save = [...node.querySelectorAll<HTMLButtonElement>("form > .rename-conversation-actions button")].find(button => button.textContent?.trim() === "保存")!.getBoundingClientRect();
      return { top: box.top, bottom: box.bottom, headerTop: header.top, titleTop: title.top, actionsBottom: actions.bottom, saveBottom: save.bottom, overflow: node.querySelector(".settings-dialog-body")!.scrollHeight - node.querySelector(".settings-dialog-body")!.clientHeight, innerHeight };
    });
    const rest = await geometry();
    expect(rest.overflow).toBeGreaterThan(40); // the content really scrolls at this height
    expect(rest.headerTop).toBeGreaterThanOrEqual(rest.top - 0.5);
    expect(rest.titleTop).toBeGreaterThan(rest.top);
    // The title stays below the 59px notch while the form body scrolls.
    await dialog.evaluate((node: HTMLElement) => { const body = node.querySelector<HTMLElement>(".settings-dialog-body")!; body.scrollTop = Math.round((body.scrollHeight - body.clientHeight) / 2); });
    await expect.poll(async () => { const value = await geometry(); return Math.abs(value.headerTop - value.top - 59) <= 1; }).toBe(true);
    const middle = await geometry();
    await info.attach("group-settings-phone-geometry", { body: JSON.stringify({ rest, middle }), contentType: "application/json" });
    expect(middle.titleTop).toBeGreaterThan(middle.top);
    expect(middle.actionsBottom).toBeLessThanOrEqual(middle.bottom + 1);
    expect(middle.saveBottom).toBeLessThanOrEqual(middle.innerHeight - 34);
    await page.screenshot({ path: info.outputPath("group-settings-phone-scrolled.png") });
  } finally { await page.close(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});
