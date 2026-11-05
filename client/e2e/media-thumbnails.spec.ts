import { preparePairing } from "./fixtures/pairing-invite.js";
import { test, expect } from "@playwright/test";
import { holdMessage } from "./fixtures/message-actions.js";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HubServer } from "../../src/hub/server.js";
import { showDisconnectedBots, selectConversation, waitForClientOnline } from "./fixtures/mobile.js";

for (const width of [390, 1360]) test(`Bot media keeps its original proportions and video has a real cover (${width}px)`, async ({ browser }, info) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "media-thumbnails-"));
  const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve("dist") });
  const context = await browser.newContext({ viewport: { width, height: 1000 }, hasTouch: width < 760, serviceWorkers: "block" });
  const page = await context.newPage(), errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  try {
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('media','媒体助手','fixture')");
    const chat = await hub.store.createConversation("owner", ["media"], "媒体预览", "media-thumbnails");
    const upload = async (name: string, mime: string, bytes: Buffer) => hub.attachments.importForBot("media", {
      conversationId: chat.id, name, mime, size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"),
    }, bytes);
    const sizes = [[600, 800], [960, 540], [800, 600], [540, 960]];
    const images = [];
    for (const [w, h] of sizes) {
      const bytes = Buffer.from(await page.evaluate(([w, h]) => {
        const canvas = document.createElement("canvas"); canvas.width = w!; canvas.height = h!;
        const ctx = canvas.getContext("2d")!;
        ctx.fillStyle = "#ffe9ef"; ctx.fillRect(0, 0, w!, h!);
        ctx.strokeStyle = "#994e66"; ctx.lineWidth = 12; ctx.strokeRect(6, 6, w! - 12, h! - 12);
        ctx.fillStyle = "#432a37"; ctx.font = "bold 48px sans-serif"; ctx.fillText(`${w} × ${h}`, 24, 70);
        ctx.font = "32px sans-serif"; ctx.fillText("Full image", 24, h! - 35);
        return canvas.toDataURL("image/png").split(",")[1]!;
      }, [w!, h!]), "base64");
      images.push({ type: "image" as const, attachmentId: await upload(`${w}x${h}.png`, "image/png", bytes), title: `${w} × ${h}` });
    }
    // Both native batch delivery (card elements) and consecutive image blocks
    // must keep their ratios. This is the same captioned layout as Bot galleries.
    const galleryCaption = "这组图片保留原比例，文字和图片放在一起。";
    const galleryMessage = await hub.store.publishBotMessage("media", { conversationId: chat.id, blocks: [{ type: "text", text: galleryCaption }, ...(width < 760 ? images : [{
      type: "card", elements: images.flatMap(image => [
        { type: "markdown" as const, text: image.title }, { type: "image" as const, attachmentId: image.attachmentId },
      ]),
    } as const])] });
    // Exact app_send_batch shape from the reported split caption/gallery bubble.
    const batchCaption = "GitHub 首页更新后的实际效果";
    const batchMessage = await hub.store.publishBotMessage("media", { conversationId: chat.id, blocks: [
      { type: "text", text: batchCaption },
      { type: "card", elements: images.slice(0, 2).map(image => ({ type: "image", attachmentId: image.attachmentId, text: image.title })) },
    ] });
    const bytes = await readFile("e2e/fixtures/media/clip.mp4");
    const mime = width < 760 ? "video/mp4" : "application/octet-stream";
    const attachmentId = await upload("video.mp4", mime, bytes);
    await hub.store.publishBotMessage("media", { conversationId: chat.id, blocks: [{ type: "file", attachmentId, name: "video.mp4", mime, size: bytes.length }] });
    await page.goto(hub.url); await preparePairing(page, hub); await page.getByRole("button", { name: "配对此设备", exact: true }).click();
    await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
    await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" });
    await waitForClientOnline(page); await showDisconnectedBots(page); await selectConversation(page, chat.title);
    for (const [id, caption, count] of [[galleryMessage.id, galleryCaption, 4], [batchMessage.id, batchCaption, 2]] as const) {
      const row = page.locator(`[data-message-id="${id}"]`);
      await row.scrollIntoViewIfNeeded();
      await expect(row.locator(".rich-card")).toHaveCount(1);
      const surface = row.locator(".rich-card");
      await expect(surface.getByText(caption, { exact: true })).toBeVisible();
      await expect(surface.locator(".image-thumbnail img")).toHaveCount(count);
      // Images below the viewport correctly keep their native lazy-loading
      // budget. Bring each into view before asserting it has decoded.
      for (const img of await surface.locator(".image-thumbnail img").all()) {
        await img.scrollIntoViewIfNeeded();
        await expect.poll(() => img.evaluate((node: HTMLImageElement) => node.naturalWidth)).toBeGreaterThan(0);
      }
      await expect.poll(() => surface.locator(".image-thumbnail img").evaluateAll(nodes => nodes.every(node => (node as HTMLImageElement).naturalWidth > 0))).toBe(true);
      expect((await hub.store.snapshot("owner", chat.id)).messages.find(message => message.id === id)?.blocks).toEqual(id === galleryMessage.id ? galleryMessage.blocks : batchMessage.blocks);
    }
    await page.locator(`[data-message-id="${batchMessage.id}"]`).screenshot({ path: info.outputPath(`captioned-batch-${width}.png`) });
    const gallery = page.locator(`[data-message-id="${galleryMessage.id}"] .image-grid`);
    for (const palette of ["mono", "cli"]) {
      await page.evaluate(palette => { document.documentElement.dataset.palette = palette; }, palette);
      for (let i = 0; i < sizes.length; i++) {
        const img = gallery.locator(".image-thumbnail img").nth(i);
        await expect.poll(() => img.evaluate((node: HTMLImageElement) => node.naturalWidth)).toBe(sizes[i]![0]);
        const box = (await img.boundingBox())!;
        expect(box.width / box.height).toBeCloseTo(sizes[i]![0]! / sizes[i]![1]!, 2);
        expect(box.height).toBeLessThanOrEqual(320);
        await expect(img).toHaveCSS("object-fit", "contain");
      }
    }
    await page.evaluate(() => { document.documentElement.dataset.palette = "mono"; });
    await gallery.screenshot({ path: info.outputPath(`image-ratios-${width}.png`) });
    const card = page.getByRole("region", { name: "video.mp4", exact: true }), cover = card.locator(".video-thumbnail img");
    await card.scrollIntoViewIfNeeded();
    await expect(cover).toBeVisible();
    await expect(card.locator(".video-duration")).toHaveText("0:03");
    expect(await cover.evaluate((node: HTMLImageElement) => [node.naturalWidth, node.naturalHeight])).toEqual([160, 90]);
    // A thumbnail is a decoded frame, not an empty black placeholder or autoplaying video.
    expect(await cover.evaluate((node: HTMLImageElement) => {
      const canvas = document.createElement("canvas"); canvas.width = 160; canvas.height = 90;
      const ctx = canvas.getContext("2d")!; ctx.drawImage(node, 0, 0);
      const colors = new Set<number>(), data = ctx.getImageData(0, 0, 160, 90).data;
      for (let i = 0; i < data.length; i += 4) colors.add((data[i]! << 16) | (data[i + 1]! << 8) | data[i + 2]!);
      return colors.size;
    })).toBeGreaterThan(100);
    await expect(page.locator("video")).toHaveCount(0);
    await card.screenshot({ path: info.outputPath(`video-cover-${width}.png`) });
    await page.screenshot({ path: info.outputPath(`media-${width}.png`) });
    if (width <= 760) {
      await holdMessage(page, card.locator('xpath=ancestor::article'), card.getByRole("button", { name: "预览 video.mp4", exact: true }));
      const sheet = page.getByRole("dialog", { name: "消息操作", exact: true });
      await expect(sheet.getByRole("button", { name: "引用回复", exact: true })).toBeEnabled();
      await expect(sheet.getByRole("button", { name: "转发消息", exact: true })).toBeEnabled();
      await expect(page.getByRole("dialog", { name: "文件预览", exact: true })).toHaveCount(0);
      await page.keyboard.press("Escape");
    }
    await card.getByRole("button", { name: "预览 video.mp4", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "文件预览", exact: true });
    const video = dialog.locator("video");
    await expect.poll(() => video.evaluate((node: HTMLVideoElement) => node.readyState)).toBeGreaterThanOrEqual(2);
    await video.evaluate(async (node: HTMLVideoElement) => { node.muted = true; await node.play(); });
    await expect.poll(() => video.evaluate((node: HTMLVideoElement) => node.currentTime)).toBeGreaterThan(.1);
    await dialog.getByRole("button", { name: "关闭", exact: true }).click();
    const download = page.waitForEvent("download"); await card.getByRole("button", { name: "另存为 video.mp4", exact: true }).click();
    expect(await readFile((await (await download).path())!)).toEqual(bytes);
    await gallery.getByRole("button", { name: images[3]!.title, exact: true }).click();
    const imageDialog = page.getByRole("dialog", { name: "图片预览", exact: true });
    expect(await imageDialog.locator("img").evaluate((node: HTMLImageElement) => [node.naturalWidth, node.naturalHeight])).toEqual(sizes[3]);
    await imageDialog.getByRole("button", { name: "关闭", exact: true }).click();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(errors).toEqual([]);
  } finally { await context.close(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});

test("large videos wait for an explicit preview, and undecodable videos retain usable file actions", async ({ page }) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "media-thumbnail-limits-"));
  const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve("dist") });
  try {
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('media','媒体助手','fixture')");
    const chat = await hub.store.createConversation("owner", ["media"], "视频边界", "video-limits");
    const clip = await readFile("e2e/fixtures/media/clip.mp4");
    // A valid MP4 with padding, beyond the automatic-original cache budget.
    const large = Buffer.concat([clip, Buffer.alloc(16 * 1024 ** 2 + 1 - clip.length)]);
    const broken = Buffer.from("Undecodable video fixture");
    const ids: string[] = [];
    for (const [name, bytes] of [["broken.mp4", broken], ["large.mp4", large]] as const) {
      const attachmentId = await hub.attachments.importForBot("media", { conversationId: chat.id, name, mime: "video/mp4", size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") }, bytes);
      ids.push(attachmentId);
      await hub.store.publishBotMessage("media", { conversationId: chat.id, blocks: [{ type: "file", attachmentId, name, mime: "video/mp4", size: bytes.length }] });
    }
    const requests = new Map<string, number>();
    page.on("request", request => { const id = new URL(request.url()).pathname.split("/api/attachments/")[1]; if (id) requests.set(id, (requests.get(id) ?? 0) + 1); });
    await page.goto(hub.url); await preparePairing(page, hub); await page.getByRole("button", { name: "配对此设备", exact: true }).click();
    await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
    await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" });
    await waitForClientOnline(page); await showDisconnectedBots(page); await selectConversation(page, chat.title);
    const bad = page.getByRole("region", { name: "broken.mp4", exact: true }), big = page.getByRole("region", { name: "large.mp4", exact: true });
    await bad.scrollIntoViewIfNeeded();
    await expect.poll(() => requests.get(ids[0]!)).toBeGreaterThan(0);
    await bad.getByRole("button", { name: "预览 broken.mp4", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "文件预览", exact: true });
    await expect(dialog).toContainText("此设备无法预览该文件，请另存为后打开。");
    await dialog.getByRole("button", { name: "关闭", exact: true }).click();
    const download = page.waitForEvent("download"); await bad.getByRole("button", { name: "另存为 broken.mp4", exact: true }).click();
    expect(await readFile((await (await download).path())!)).toEqual(broken);
    await big.scrollIntoViewIfNeeded();
    await expect(big.locator(".video-thumbnail button")).toBeInViewport();
    expect(requests.get(ids[1]!) ?? 0).toBe(0);
    await expect(big.locator(".video-thumbnail img")).toHaveCount(0);
    await big.getByRole("button", { name: "预览 large.mp4", exact: true }).click();
    await expect(dialog.locator("video")).toBeVisible();
    await expect.poll(() => big.locator(".video-thumbnail img").count()).toBe(1);
    const readCount = requests.get(ids[1]!);
    await dialog.getByRole("button", { name: "关闭", exact: true }).click();
    await expect(big.locator(".video-duration")).toHaveText("0:03");
    expect(requests.get(ids[1]!)).toBe(readCount); // Cover reuses explicit-preview bytes.
  } finally { await page.close(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});
