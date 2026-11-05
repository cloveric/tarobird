import { preparePairing } from "./fixtures/pairing-invite.js";
import { test, expect, type Page } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HubServer } from "../../src/hub/server.js";
import { showDisconnectedBots, selectConversation } from "./fixtures/mobile.js";
import { settleReadingLayout } from "./fixtures/reading-position.js";

test.use({ serviceWorkers: "block" });

async function pair(page: Page, hub: HubServer, title: string) {
  await page.goto(hub.url);
  await preparePairing(page, hub); await page.getByRole("button", { name: "配对此设备", exact: true }).click();
  await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
  await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" }); await showDisconnectedBots(page);
  await selectConversation(page, title);
}

test("desktop scrollbar return resumes following later streaming growth", async ({ page }) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "scrollbar-following-"));
  const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve("dist") });
  try {
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('bot','阅读助手','fixture')");
    const chat = await hub.store.createConversation("owner", ["bot"], "滚动条阅读", "scrollbar");
    let text = Array.from({ length: 50 }, (_, i) => `第 ${i + 1} 段：阅读较早的输出，然后拖动滚动条回到底部。`).join("\n\n");
    const message = await hub.store.publishBotMessage("bot", { conversationId: chat.id, blocks: [{ type: "text", text }], status: "streaming" });
    await pair(page, hub, chat.title);
    const scroller = page.locator(".message-scroll"), latest = page.getByRole("button", { name: "回到最新消息", exact: true });
    await settleReadingLayout(scroller);
    await scroller.hover(); await page.mouse.wheel(0, -700);
    await expect(latest).toBeVisible(); await settleReadingLayout(scroller);
    const box = (await scroller.boundingBox())!;
    // Native scrollbar dragging varies across OS/headless engines. Keep real
    // pointer down/up on the scroll surface and model only the scrollbar's
    // displacement, without inventing wheel/touch/keyboard intent.
    await page.mouse.move(box.x + box.width - 2, box.y + box.height / 2); await page.mouse.down();
    await scroller.evaluate(node => { node.scrollTop = node.scrollHeight; });
    await page.mouse.up();
    await expect.poll(() => scroller.evaluate(node => node.scrollHeight - node.clientHeight - node.scrollTop)).toBeLessThan(2);
    await expect(latest).toHaveCount(0);
    text += "\n\n" + "拖回底部后的流式内容。".repeat(100);
    await hub.store.publishBotMessage("bot", { id: message.id, conversationId: chat.id, blocks: [{ type: "text", text }], status: "streaming" });
    await expect(scroller).toContainText("拖回底部后的流式内容。"); await settleReadingLayout(scroller);
    await expect.poll(() => scroller.evaluate(node => node.scrollHeight - node.clientHeight - node.scrollTop)).toBeLessThan(2);
    // A single drag can start at the tail, move up, then return to its original
    // position. Releasing there is still an explicit return to latest.
    await page.mouse.move(box.x + box.width - 2, box.y + box.height / 2); await page.mouse.down();
    await scroller.evaluate(node => { node.scrollTop -= 150; });
    await expect(latest).toBeVisible();
    await scroller.evaluate(node => { node.scrollTop = node.scrollHeight; }); await page.mouse.up();
    await expect(latest).toHaveCount(0);
    text += "\n\n" + "同一次拖动回到底部后继续跟随。".repeat(50);
    await hub.store.publishBotMessage("bot", { id: message.id, conversationId: chat.id, blocks: [{ type: "text", text }], status: "streaming" });
    await expect(scroller).toContainText("同一次拖动回到底部后继续跟随。"); await settleReadingLayout(scroller);
    await expect.poll(() => scroller.evaluate(node => node.scrollHeight - node.clientHeight - node.scrollTop)).toBeLessThan(2);
  } finally { await page.close(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});

test.describe("touch target lifecycle", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  test("a real touch ending on the removed empty state releases following", async ({ page, browserName }) => {
    test.skip(browserName !== "chromium", "Trusted touch dispatch is available through Chromium only");
    const root = await mkdtemp(path.join(os.tmpdir(), "detached-touch-following-"));
    const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve("dist") });
    const touch = await page.context().newCDPSession(page);
    try {
      await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('bot','阅读助手','fixture')");
      const chat = await hub.store.createConversation("owner", ["bot"], "触点移除", "detached-touch");
      await pair(page, hub, chat.title);
      const target = page.locator(".direct-empty p"), scroller = page.locator(".message-scroll");
      await expect(target).toBeVisible();
      await target.evaluate(node => {
        const observed = { started: false, ended: false, detachedAtEnd: false, bubbled: false };
        Object.assign(window, { detachedTouch: observed });
        node.addEventListener("touchstart", () => { observed.started = true; });
        node.addEventListener("touchend", event => { observed.ended = event.isTrusted; observed.detachedAtEnd = !node.isConnected; });
        window.addEventListener("touchend", () => { observed.bubbled = true; }, { capture: true, once: true });
      });
      const box = (await target.boundingBox())!;
      await touch.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: box.x + box.width / 2, y: box.y + box.height / 2 }] });
      await expect.poll(() => page.evaluate(() => (window as any).detachedTouch.started)).toBe(true);
      const message = await hub.store.publishBotMessage("bot", { conversationId: chat.id, blocks: [{ type: "text", text: "首条回复" }], status: "streaming" });
      await expect(target).toHaveCount(0);
      await touch.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      expect(await page.evaluate(() => (window as any).detachedTouch)).toEqual({ started: true, ended: true, detachedAtEnd: true, bubbled: false });
      await hub.store.publishBotMessage("bot", { id: message.id, conversationId: chat.id, blocks: [{ type: "text", text: Array.from({ length: 50 }, (_, i) => `松手后的第 ${i + 1} 段输出。`).join("\n\n") }], status: "streaming" });
      await expect(scroller).toContainText("松手后的第 50 段输出。"); await settleReadingLayout(scroller);
      await expect.poll(() => scroller.evaluate(node => node.scrollHeight - node.clientHeight - node.scrollTop)).toBeLessThan(2);
    } finally { await touch.detach(); await page.close(); await hub.close(); await rm(root, { recursive: true, force: true }); }
  });
});
