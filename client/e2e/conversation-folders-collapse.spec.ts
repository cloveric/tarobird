import { preparePairing } from "./fixtures/pairing-invite.js";
import { test, expect, type Page } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HubServer } from "../../src/hub/server.js";
import { ConversationFolders } from "../../src/hub/conversation-folders.js";
import { mobileHome, showDisconnectedBots, waitForClientOnline } from "./fixtures/mobile.js";

test.use({ serviceWorkers: "block", viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

async function pair(page: Page, hub: HubServer) {
  await page.goto(hub.url); await preparePairing(page, hub); await page.getByRole("button", { name: "配对此设备", exact: true }).click();
  await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
  await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" }); await showDisconnectedBots(page);
}

// A-8: a collapsed folder stays collapsed across a tab round trip (which
// remounts the phone list) and an App restart, per host.
test("phone folder collapse survives switching tabs and reloading", async ({ page }) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "folder-collapse-"));
  const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve("dist") });
  try {
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('bot','分组助手','fixture')");
    const work = await hub.store.createConversation("owner", ["bot"], "工作对话", "work-chat");
    await hub.store.createConversation("owner", ["bot"], "未分组对话", "loose-chat");
    const folders = new ConversationFolders(hub.store.db);
    await folders.change("owner", { type: "create", id: "work", name: "工作", revision: 0, conversationId: work.id });
    await pair(page, hub);
    const nav = mobileHome(page).getByRole("navigation", { name: "主导航" });
    const unfiled = mobileHome(page).locator('[data-folder-id=""] .folder-heading');
    const workHeading = mobileHome(page).locator('[data-folder-id="work"] .folder-heading');
    await expect(unfiled).toHaveAttribute("aria-expanded", "true");
    await unfiled.tap();
    await expect(unfiled).toHaveAttribute("aria-expanded", "false");
    await expect(mobileHome(page).getByText("未分组对话", { exact: true })).toBeHidden();
    await nav.getByRole("button", { name: /^Bot/ }).click();
    await nav.getByRole("button", { name: /^消息/ }).click();
    await expect(unfiled).toHaveAttribute("aria-expanded", "false");
    await expect(workHeading).toHaveAttribute("aria-expanded", "true");
    await page.reload(); await waitForClientOnline(page);
    await expect(unfiled).toHaveAttribute("aria-expanded", "false");
    await expect(workHeading).toHaveAttribute("aria-expanded", "true");
    await unfiled.tap();
    await expect(unfiled).toHaveAttribute("aria-expanded", "true");
    await expect(mobileHome(page).getByText("未分组对话", { exact: true })).toBeVisible();
  } finally { await page.close(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});
