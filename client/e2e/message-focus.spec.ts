import { preparePairing } from "./fixtures/pairing-invite.js";
import { test, expect, type Page } from "@playwright/test";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServer } from "./fixtures/vite.js";
import { HubServer } from "../../src/hub/server.js";
import { waitForClientOnline } from "./fixtures/mobile.js";

test.use({ serviceWorkers: "block" });

async function pair(page: Page, url: string, hub: HubServer) {
  await page.goto(url); await page.getByRole("textbox", { name: "Hub 地址", exact: true }).fill(hub.url);
  await preparePairing(page, hub); await page.getByRole("button", { name: "配对此设备", exact: true }).click();
  await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
  await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" });
  await waitForClientOnline(page);
}

test("a located history message is positioned once, without pulling the reader back on later replies", async ({ page }) => {
  test.setTimeout(90_000);
  const root = await mkdtemp(path.join(os.tmpdir(), "message-focus-"));
  const server = await createServer({ server: { port: 0, host: "127.0.0.1" } }); await server.listen();
  const url = server.resolvedUrls!.local[0]!;
  const hub = await HubServer.start({ stateDir: root, origins: [new URL(url).origin] });
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  try {
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','阅读助手','fixture')");
    const chat = await hub.store.createConversation("owner", ["alpha"], "定位阅读", "focus_chat");
    const ids: string[] = [];
    for (let i = 0; i < 70; i++) {
      const text = i === 40 ? "定位目标 ZETA-MARK，需要居中查看。" : `第 ${i + 1} 条历史记录。` + "用于填充阅读高度的说明。".repeat(1 + i % 5);
      ids.push((await hub.store.publishBotMessage("alpha", { conversationId: chat.id, blocks: [{ type: "text", text }] })).id);
      await new Promise(resolve => setTimeout(resolve, 2)); // Distinct creation times keep the order exact.
    }
    // The search target loads with another chat selected first.
    const other = await hub.store.createConversation("owner", ["alpha"], "其他对话", "other_chat");
    await hub.store.publishBotMessage("alpha", { conversationId: other.id, blocks: [{ type: "text", text: "另一段对话" }] });
    await pair(page, url, hub);
    const scroller = page.locator(".host-workspace:not([hidden]) .message-scroll");
    const target = page.locator(`[data-message-id="${ids[40]}"]`);
    const top = () => scroller.evaluate(node => node.scrollTop);
    const settled = async () => {
      let last = Number.NaN;
      await expect.poll(async () => { const now = await top(); const same = Math.abs(now - last) < 1; last = now; return same; }, { intervals: [300] }).toBe(true);
      return last;
    };
    const centerOffset = () => target.evaluate((node) => {
      const viewport = node.closest(".message-scroll")!.getBoundingClientRect(), row = node.getBoundingClientRect();
      return (row.top + row.bottom) / 2 - (viewport.top + viewport.bottom) / 2;
    });
    const search = page.getByRole("textbox", { name: "搜索历史消息", exact: true });
    await search.fill("ZETA-MARK"); await search.press("Enter");
    await page.locator(".search-results > button").first().click();
    await expect(target).toHaveClass(/focused-message/); await expect(target).toBeInViewport();
    await expect(target.locator(".message-body")).toHaveCSS("outline-style", "none");
    const centered = await settled();
    expect(Math.abs(await centerOffset())).toBeLessThan(40);

    // Before any reader gesture, a removed row above re-centers the same target.
    await hub.store.publishBotMessage("alpha", { id: ids[30], conversationId: chat.id, blocks: [], status: "deleted" });
    await expect(page.locator(`[data-message-id="${ids[30]}"]`)).toHaveCount(0);
    await settled(); expect(Math.abs(await centerOffset())).toBeLessThan(40);

    // After the reader moves, replies and refreshes never pull them back.
    await scroller.hover(); await page.mouse.wheel(0, -450);
    const reading = await settled(); expect(reading).toBeLessThan(centered - 150);
    for (const text of ["阅读期间的新回复", "另一条新回复"]) {
      const height = await scroller.evaluate(node => node.scrollHeight);
      await hub.store.publishBotMessage("alpha", { conversationId: chat.id, blocks: [{ type: "text", text }] });
      await expect.poll(() => scroller.evaluate(node => node.scrollHeight)).toBeGreaterThan(height);
      expect(Math.abs(await settled() - reading)).toBeLessThanOrEqual(2);
    }
    await expect(target).toHaveClass(/focused-message/);

    // An intentional return to the tail ends the request, like "back to latest".
    for (let i = 0; i < 40 && await scroller.evaluate(node => node.scrollHeight - node.scrollTop - node.clientHeight > 2); i++) await page.mouse.wheel(0, 600);
    await expect(page.locator(".focused-message")).toHaveCount(0);
    const live = await hub.store.publishBotMessage("alpha", { conversationId: chat.id, blocks: [{ type: "text", text: "回到底部后继续跟随" }] });
    await expect(page.locator(`[data-message-id="${live.id}"]`)).toBeInViewport();
    expect(errors).toEqual([]);
  } finally { await hub.close(); await server.close(); await rm(root, { recursive: true, force: true }); }
});

for (const width of [390, 1360]) test(`notification navigation locates the reply without a surrounding frame (${width})`, async ({ browser }, info) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "notification-location-"));
  const server = await createServer({ server: { port: 0, host: "127.0.0.1" } }); await server.listen();
  const url = server.resolvedUrls!.local[0]!;
  const hub = await HubServer.start({ stateDir: root, origins: [new URL(url).origin] });
  const context = await browser.newContext({ viewport: { width, height: 844 }, hasTouch: width === 390, serviceWorkers: "block", reducedMotion: "reduce" });
  const page = await context.newPage(), errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  try {
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','阅读助手','fixture')");
    const chat = await hub.store.createConversation("owner", ["alpha"], "通知定位", "notification_chat");
    const ids: string[] = [];
    for (let i = 0; i < 25; i++) ids.push((await hub.store.publishBotMessage("alpha", {
      conversationId: chat.id,
      blocks: [{ type: "text", text: i === 10 ? "已完成本次检查。\n\n这条回复由通知打开，直接阅读正文即可。\n\n消息位置仍然保留，也可以回到最新消息。" : `第 ${i + 1} 条历史记录。` + "用于验证通知定位与历史阅读。".repeat(3) }],
    })).id);
    const other = await hub.store.createConversation("owner", ["alpha"], "另一段对话", "notification_other");
    await hub.store.publishBotMessage("alpha", { conversationId: other.id, blocks: [{ type: "text", text: "从这里跳转到通知对应的回复。" }] });
    await pair(page, url, hub);
    const hostId = `hub_${createHash("sha256").update(Buffer.from(hub.auth.publicKey, "base64")).digest("hex")}`;
    const target = page.locator(`[data-message-id="${ids[10]}"]`), body = target.locator(".message-body");
    // The same accepted navigation event is emitted by native notification taps.
    await page.evaluate(detail => window.dispatchEvent(new CustomEvent("tarocub-navigate", { cancelable: true, detail })), { hostId, conversationId: chat.id, messageId: ids[10] });
    await expect(page.getByRole("heading", { name: chat.title, exact: true, level: 1 })).toBeVisible();
    await expect(target).toHaveClass(/focused-message/); await expect(target).toBeInViewport();
    for (const palette of ["mono", "white-violet", "cli"]) for (const theme of ["light", "dark"]) {
      await page.evaluate(settings => Object.assign(document.documentElement.dataset, settings), { palette, theme });
      if (palette === "mono") await page.screenshot({ path: info.outputPath(`notification-${width}-${theme}.png`), animations: "disabled" });
      await expect(body).toHaveCSS("outline-style", "none");
      await expect(body).toHaveCSS("box-shadow", "none");
    }
    // Locating a message remains distinct from following new replies.
    const latest = await hub.store.publishBotMessage("alpha", { conversationId: chat.id, blocks: [{ type: "text", text: "通知打开以后收到的新回复" }] });
    await expect(target).toHaveClass(/focused-message/); await expect(target).toBeInViewport();
    // The existing latest-message control appears after a reading gesture.
    await page.locator(".host-workspace:not([hidden]) .message-scroll").press("ArrowUp");
    const back = page.getByRole("button", { name: "回到最新消息", exact: true });
    await expect(back).toBeVisible();
    await back.focus();
    await expect(back).toHaveCSS("outline-style", "solid");
    await back.click();
    await expect(page.locator(".focused-message")).toHaveCount(0);
    await expect(page.locator(`[data-message-id="${latest.id}"]`)).toBeInViewport();
    expect(errors).toEqual([]);
  } finally { await context.close(); await hub.close(); await server.close(); await rm(root, { recursive: true, force: true }); }
});
