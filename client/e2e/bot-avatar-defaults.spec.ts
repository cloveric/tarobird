import { preparePairing } from "./fixtures/pairing-invite.js";
import { test, expect } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HubServer } from "../../src/hub/server.js";
import { BOT_AVATAR_DEFAULT_PREFIX } from "../../src/hub/bot-avatar-default.js";
import { defaultBotAvatar } from "../src/bot-avatar-catalog.js";
import { showDisconnectedBots, selectConversation, waitForClientOnline } from "./fixtures/mobile.js";

for (const width of [1360, 390]) for (const assignedId of ["mini-matcha", "mini-corgi", "mini-croissant"]) test(`assigned ${assignedId} and legacy identity survive offline reload at ${width}`, async ({ browser }) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "avatar-default-ui-"));
  const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve("dist") });
  const context = await browser.newContext({ viewport: { width, height: 844 }, ...(width === 390 ? { isMobile: true, hasTouch: true } : {}) });
  const page = await context.newPage();
  try {
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','全库头像','fixture'),('beta','原有头像','fixture')");
    await hub.store.db.run("INSERT INTO meta(key,value) VALUES(?,?)", [BOT_AVATAR_DEFAULT_PREFIX + "alpha", assignedId]);
    const chat = await hub.store.createConversation("owner", ["alpha"], "全库分配验收", "new-avatar");
    const old = await hub.store.createConversation("owner", ["beta"], "原有头像保留", "old-avatar");
    await hub.store.publishBotMessage("alpha", { conversationId: chat.id, blocks: [{ type: "text", text: "全库头像会保持一致" }] });
    await hub.store.publishBotMessage("beta", { conversationId: old.id, blocks: [{ type: "text", text: "旧头像保持不变" }] });
    await page.goto(hub.url);
    await preparePairing(page, hub); await page.getByRole("button", { name: "配对此设备", exact: true }).click();
    await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
    await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" });
    await showDisconnectedBots(page); await waitForClientOnline(page);
    await selectConversation(page, old.title);
    await expect(page.locator('[data-avatar="bot:beta"]').first()).toHaveAttribute("data-preset", defaultBotAvatar("beta").id);
    await selectConversation(page, chat.title);
    const portrait = () => page.locator('[data-avatar="bot:alpha"]').first();
    await expect(portrait()).toHaveAttribute("data-preset", assignedId);
    await expect.poll(() => page.evaluate(async assignedId => {
      for (const info of await indexedDB.databases()) {
        if (!info.name) continue;
        const db = await new Promise<IDBDatabase>((resolve, reject) => { const request = indexedDB.open(info.name!); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
        try {
          if (!db.objectStoreNames.contains("settings")) continue;
          const raw = await new Promise<unknown>((resolve, reject) => { const request = db.transaction("settings").objectStore("settings").get("botNames"); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
          if (typeof raw === "string" && JSON.parse(raw).some((bot: { id: string; defaultAvatar?: string }) => bot.id === "alpha" && bot.defaultAvatar === assignedId)) return true;
        } finally { db.close(); }
      }
      return false;
    }, assignedId)).toBe(true);
    // Keep the static App shell available while every Host websocket is down.
    // This exercises the cold offline directory, not the previous live React state.
    await context.routeWebSocket(/.*/, socket => socket.close());
    await page.reload();
    await expect(portrait()).toHaveAttribute("data-preset", assignedId);
    await expect.poll(() => portrait().locator("img").evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth === 256)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  } finally { await context.close(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});
