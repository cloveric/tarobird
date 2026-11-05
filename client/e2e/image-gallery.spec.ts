import { preparePairing } from "./fixtures/pairing-invite.js";
import { test, expect, type Page, type BrowserContext, type CDPSession } from "@playwright/test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HubServer } from "../../src/hub/server.js";
import { showDisconnectedBots, selectConversation, waitForClientOnline } from "./fixtures/mobile.js";
import { singleHostCacheName } from "./fixtures/cache.js";

async function fixture(page: Page) {
  const root = await mkdtemp(path.join(os.tmpdir(), "image-gestures-"));
  const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve("dist") });
  try {
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('photo','图片助手','fixture')");
    const chat = await hub.store.createConversation("owner", ["photo"], "图片手势", "photos");
    await page.goto(hub.url);
    const originals: Buffer[] = [], images = [];
    for (const [title, width, height, color] of [["第一张", 1600, 900, "#b23432"], ["第二张", 1200, 1200, "#28774a"], ["长图", 720, 7200, "#254eb2"], ["另一条消息", 800, 600, "#873fc1"]] as const) {
      const bytes = Buffer.from(await page.evaluate(({width,height,color}) => {
        const canvas = document.createElement("canvas"); canvas.width = width; canvas.height = height;
        const ctx = canvas.getContext("2d")!; ctx.fillStyle = color; ctx.fillRect(0, 0, width, height);
        ctx.fillStyle = "white"; ctx.font = "40px sans-serif"; ctx.fillText(`${width} × ${height}`, 30, 70);
        return canvas.toDataURL("image/png").split(",")[1]!;
      }, {width,height,color}), "base64");
      originals.push(bytes);
      const id = await hub.attachments.importForBot("photo", { conversationId: chat.id, name: title + ".png", mime: "image/png", size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") }, bytes);
      images.push({ type: "image" as const, attachmentId: id, title });
    }
    const batch = await hub.store.publishBotMessage("photo", { conversationId: chat.id, blocks: [{ type: "text", text: "同一气泡的三张图" }, { type: "card", elements: images.slice(0, 3).map(image => ({ type: "image", attachmentId: image.attachmentId, text: image.title })) }] });
    const separate = await hub.store.publishBotMessage("photo", { conversationId: chat.id, blocks: [images[3]!] });
    await preparePairing(page, hub); await page.getByRole("button", { name: "配对此设备", exact: true }).click();
    await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
    await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" });
    await waitForClientOnline(page); await showDisconnectedBots(page); await selectConversation(page, chat.title);
    return { originals, batch, separate, hub, chat, close: async () => { await hub.close(); await rm(root, { recursive: true, force: true }); } };
  } catch (error) { await hub.close(); await rm(root, { recursive: true, force: true }); throw error; }
}

/** Chromium uses trusted touch input, including native gesture arbitration.
 * WebKit covers the same pointer path plus real touchscreen double taps. */
async function touchDriver(page: Page, context: BrowserContext, browserName: string) {
  let cdp: CDPSession | undefined;
  if (browserName === "chromium") cdp = await context.newCDPSession(page);
  let previous: { id: number; x: number; y: number }[] = [];
  return async (type: "touchStart" | "touchMove" | "touchEnd" | "touchCancel", points: { id: number; x: number; y: number }[]) => {
    if (cdp) await cdp.send("Input.dispatchTouchEvent", { type, touchPoints: points });
    else {
      const values = type === "touchEnd" || type === "touchCancel" ? previous.filter(p => !points.some(n => n.id === p.id)) : points;
      for (const point of values) await page.locator(".image-preview-scroll").dispatchEvent(type === "touchStart" ? "pointerdown" : type === "touchMove" ? "pointermove" : type === "touchEnd" ? "pointerup" : "pointercancel", { pointerId: point.id, pointerType: "touch", isPrimary: point.id === 1, clientX: point.x, clientY: point.y, button: 0, buttons: type === "touchEnd" ? 0 : 1, bubbles: true });
    }
    previous = points;
  };
}

for (const mode of ["gallery", "zoom"] as const) test(`phone image preview supports ${mode} touch gestures`, async ({ browser, browserName }, info) => {
  test.setTimeout(90000);
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, reducedMotion: "reduce" });
  const page = await context.newPage(), env = await fixture(page), errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  try {
    const row = page.locator(`[data-message-id="${env.batch.id}"]`);
    const opener = row.getByRole("button", { name: "第一张", exact: true }); await opener.click();
    const viewer = page.getByRole("dialog", { name: "图片预览", exact: true }), reader = viewer.locator(".image-preview-scroll"), picture = viewer.locator("img");
    await expect(picture).toBeVisible(); await expect.poll(() => picture.evaluate((n: HTMLImageElement) => n.naturalWidth)).toBe(1600);
    const touch = await touchDriver(page, context, browserName);
    const rect = (await reader.boundingBox())!, x = rect.x + rect.width / 2, y = rect.y + rect.height / 2;
    const swipe = async (dx: number, dy = 0, cancel = false, holdMs = 0) => {
      await touch("touchStart", [{id:1,x:x - dx / 2,y:y - dy / 2}]);
      if (holdMs) await page.waitForTimeout(holdMs);
      for (let i = 1; i <= 5; i++) await touch("touchMove", [{id:1,x:x - dx / 2 + dx * i / 5,y:y - dy / 2 + dy * i / 5}]);
      if (mode === "gallery" && Math.abs(dx) > Math.abs(dy) * 1.5)
        await expect(viewer.locator(".image-preview-canvas")).not.toHaveCSS("transform", "none");
      await touch(cancel ? "touchCancel" : "touchEnd", []);
      await expect(viewer.locator(".image-preview-canvas")).toHaveCSS("transform", "none");
    };
    if (mode === "gallery") {
      await swipe(-180, 0, false, 1100); await expect(picture).toHaveAttribute("alt", "第二张");
      await expect(viewer.getByLabel("图片位置")).toHaveText("2 / 3");
      const download = page.waitForEvent("download"); await viewer.getByRole("button", {name:"另存为",exact:true}).click();
      const saved = await download; expect(saved.suggestedFilename()).toBe("第二张.png"); expect(await readFile((await saved.path())!)).toEqual(env.originals[1]);
      await swipe(-180, 0, true); await expect(picture).toHaveAttribute("alt", "第二张");
      await swipe(-180); await expect(picture).toHaveAttribute("alt", "长图");
      const before = await reader.evaluate(node => node.scrollTop); await swipe(0, -240);
      expect(await reader.evaluate(node => node.scrollTop)).toBeGreaterThan(before + 100); await expect(picture).toHaveAttribute("alt", "长图");
      await swipe(-180); await expect(picture).toHaveAttribute("alt", "长图"); // no wrap or other message
      await expect(viewer.getByRole("button", {name:"下一张",exact:true})).toBeDisabled();
      await swipe(180); await expect(picture).toHaveAttribute("alt", "第二张");
      expect(await reader.evaluate(node => node.scrollTop)).toBe(0);
      await page.keyboard.press("ArrowLeft"); await expect(picture).toHaveAttribute("alt", "第一张");
      await viewer.getByRole("button", {name:"关闭",exact:true}).click(); await expect(opener).toBeFocused();
      await page.locator(`[data-message-id="${env.separate.id}"]`).getByRole("button", {name:"另一条消息",exact:true}).click();
      await expect(viewer.getByLabel("图片位置")).toHaveCount(0); await swipe(-180); await expect(picture).toHaveAttribute("alt", "另一条消息");
    } else {
      const originalWidth = (await picture.boundingBox())!.width;
      await page.touchscreen.tap(x, y); await page.touchscreen.tap(x, y);
      await expect.poll(async () => (await picture.boundingBox())!.width).toBeGreaterThan(originalWidth * 2);
      const left = await reader.evaluate(node => node.scrollLeft); await swipe(-140);
      expect(await reader.evaluate(node => node.scrollLeft)).toBeGreaterThan(left + 70); await expect(picture).toHaveAttribute("alt", "第一张");
      await page.waitForTimeout(400); await page.touchscreen.tap(x, y); await page.touchscreen.tap(x, y);
      await expect.poll(async () => (await picture.boundingBox())!.width).toBeCloseTo(originalWidth, 0);
      // A two-finger gesture scales the image, never advances the gallery.
      await touch("touchStart", [{id:1,x:x-35,y},{id:2,x:x+35,y}]);
      await touch("touchMove", [{id:1,x:x-100,y},{id:2,x:x+100,y}]); await touch("touchEnd", []);
      await expect.poll(async () => (await picture.boundingBox())!.width).toBeGreaterThan(originalWidth * 2);
      await expect(picture).toHaveAttribute("alt", "第一张");
      await viewer.getByRole("button", {name:"还原图片",exact:true}).click();
      await swipe(-180); await expect(picture).toHaveAttribute("alt", "第二张");
      expect((await picture.boundingBox())!.width).toBeLessThanOrEqual(390);
      await page.screenshot({path:info.outputPath("mobile-image-gallery.png")});
    }
    expect(errors).toEqual([]);
  } finally { await context.close(); await env.close(); }
});

for (const layout of ["desktop", "phone", "adhd"] as const) {
  for (const kind of ["image", "file"] as const) test(`${layout} ${kind} reader survives new messages and restores focus`, async ({ page }) => {
    await page.setViewportSize({ width: layout === "phone" ? 390 : 1440, height: 900 });
    const env = await fixture(page);
    try {
      let messageId = env.batch.id;
      if (kind === "file") {
        const bytes = Buffer.from("完整的文件内容，阅读时不能被新消息关掉。");
        const id = await env.hub.attachments.importForBot("photo", { conversationId: env.chat.id, name: "audit.txt", mime: "text/plain", size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") }, bytes);
        messageId = (await env.hub.store.publishBotMessage("photo", { conversationId: env.chat.id, blocks: [{ type: "file", attachmentId: id, name: "audit.txt", mime: "text/plain", size: bytes.length }] })).id;
      }
      if (layout === "adhd") {
        await page.getByRole("button", { name: "打开 ADHD 模式", exact: true }).click();
        await page.getByRole("checkbox", { name: /加入面板：.*图片手势$/ }).check();
      }
      const row = page.locator(`[data-message-id="${messageId}"]`);
      const opener = row.getByRole("button", { name: kind === "image" ? "第一张" : /^预览(?: |$)/, exact: kind === "image" });
      await opener.click();
      const reader = page.getByRole("dialog", { name: kind === "image" ? "图片预览" : "文件预览", exact: true });
      await expect(reader).toBeVisible();
      if (kind === "image") {
        await reader.getByRole("button", { name: "下一张", exact: true }).click();
        await expect(reader.locator("img")).toHaveAttribute("alt", "第二张");
      } else await expect(reader.locator("pre")).toContainText("完整的文件内容");
      for (let i = 0; i < 35; i++) await env.hub.store.publishBotMessage("photo", { conversationId: env.chat.id, blocks: [{ type: "text", text: `新的消息 ${i}：` + "后台仍在继续工作。".repeat(30) }] });
      await expect.poll(async () => {
        const latest = await env.hub.store.db.get<{ count: number }>("SELECT COUNT(*) AS count FROM messages WHERE conversation_id=?", [env.chat.id]);
        return Number(latest?.count);
      }).toBeGreaterThan(35);
      // Hub publication is not a client replay receipt. Wait for durable client
      // delivery separately from the reader/virtualization assertions below.
      const databaseName = await singleHostCacheName(page);
      await expect.poll(() => page.evaluate(async ({ databaseName, id }) => {
        const db = await new Promise<IDBDatabase>((resolve, reject) => { const request = indexedDB.open(databaseName); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
        try { return await new Promise<number>((resolve, reject) => { const request = db.transaction("messages").objectStore("messages").index("conversation").count(id); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); }); }
        finally { db.close(); }
      }, { databaseName, id: env.chat.id }), { timeout: 20_000 }).toBeGreaterThan(35);
      // A modal deliberately retains the reader's background scroll position.
      // Move that virtual viewport explicitly: the last message must render
      // while the pinned opener and its portalled reader both remain mounted.
      await expect.poll(() => page.locator(".message-scroll").last().evaluate(node => {
        node.scrollTop = node.scrollHeight;
        return node.textContent?.includes("新的消息 34");
      })).toBe(true);
      await expect(reader).toBeVisible();
      await expect(row).toHaveCount(1);
      if (kind === "image") await expect(reader.locator("img")).toHaveAttribute("alt", "第二张");
      await page.keyboard.press("Escape");
      await expect(reader).toHaveCount(0);
      await expect(opener).toBeFocused();
      await page.keyboard.press("Enter");
      await expect(reader).toBeVisible();
    } finally { await page.close(); await env.close(); }
  });
}
