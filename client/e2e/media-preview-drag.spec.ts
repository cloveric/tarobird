import { preparePairing } from "./fixtures/pairing-invite.js";
import { test, expect, type Locator, type Page } from "@playwright/test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HubServer } from "../../src/hub/server.js";
import { showDisconnectedBots, selectConversation, waitForClientOnline } from "./fixtures/mobile.js";

test.use({ viewport: { width: 1440, height: 1000 }, serviceWorkers: "block" });
const name = "clip.mp4";
async function fixture(page: Page, run: (bytes: Buffer, hub: HubServer, chatId: string) => Promise<void>) {
  const root = await mkdtemp(path.join(os.tmpdir(), "video-drag-"));
  const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve("dist") });
  try {
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('media','播放助手','fixture')");
    const chat = await hub.store.createConversation("owner", ["media"], "视频预览拖动", "video-drag");
    const bytes = await readFile(`e2e/fixtures/media/${name}`), mime = "video/mp4";
    const attachmentId = await hub.attachments.importForBot("media", { conversationId: chat.id, name, mime, size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") }, bytes);
    await hub.store.publishBotMessage("media", { conversationId: chat.id, blocks: [{ type: "file", attachmentId, name, mime, size: bytes.length }] });
    await page.goto(hub.url); await preparePairing(page, hub); await page.getByRole("button", { name: "配对此设备", exact: true }).click();
    await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
    await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" }); await showDisconnectedBots(page);
    await waitForClientOnline(page); await selectConversation(page, chat.title); await run(bytes, hub, chat.id);
  } finally { await page.close(); await hub.close(); await rm(root, { recursive: true, force: true }); }
}
async function drag(page: Page, panel: Locator, dx: number, dy: number) {
  const title = (await panel.locator("header > strong").boundingBox())!;
  await page.mouse.move(title.x + 24, title.y + title.height / 2); await page.mouse.down();
  await page.mouse.move(title.x + 24 + dx, title.y + title.height / 2 + dy, { steps: 6 }); await page.mouse.up();
}
async function reachable(page: Page, panel: Locator) {
  await expect.poll(() => panel.evaluate(node => {
    const r = node.getBoundingClientRect();
    return r.left >= 11 && r.top >= 11 && r.right <= innerWidth - 11 && r.bottom <= innerHeight - 11;
  })).toBe(true);
  await expect(panel.getByRole("button", { name: "关闭", exact: true })).toBeInViewport();
}

test("desktop video moves by its header without restarting playback or intercepting controls", async ({ page }, info) => {
  await fixture(page, async bytes => {
    const opener = page.getByRole("region", { name, exact: true }).getByRole("button", { name: `预览 ${name}`, exact: true });
    await opener.click();
    const dialog = page.getByRole("dialog", { name: "文件预览", exact: true }), panel = dialog.locator(".file-preview"), video = dialog.locator("video");
    await expect.poll(() => video.evaluate((node: HTMLVideoElement) => node.readyState)).toBeGreaterThanOrEqual(2);
    const original = (await panel.boundingBox())!;
    await video.evaluate(async (node: HTMLVideoElement) => { (window as any).__dragVideo = node; node.muted = true; node.loop = true; await node.play(); });
    await drag(page, panel, 140, 45);
    const moved = (await panel.boundingBox())!;
    expect(moved.x - original.x).toBeCloseTo(140, 0); expect(moved.y - original.y).toBeCloseTo(45, 0);
    await expect(panel.locator("header")).toHaveCSS("cursor", "grab");
    expect(await video.evaluate((node: HTMLVideoElement) => node === (window as any).__dragVideo && !node.paused && !node.error)).toBe(true);
    await video.evaluate((node: HTMLVideoElement) => { node.pause(); node.currentTime = 1.5; });
    await expect.poll(() => video.evaluate((node: HTMLVideoElement) => !node.seeking && Math.abs(node.currentTime - 1.5) < .15)).toBe(true);
    // The video area itself does not move the window.
    const picture = (await video.boundingBox())!; await page.mouse.move(picture.x + picture.width / 2, picture.y + picture.height / 2);
    await page.mouse.down(); await page.mouse.move(picture.x + picture.width / 2 + 40, picture.y + picture.height / 2 + 20); await page.mouse.up();
    expect(await panel.boundingBox()).toEqual(moved);
    const download = page.waitForEvent("download"); await panel.getByRole("button", { name: "另存为", exact: true }).click();
    expect(await readFile((await (await download).path())!)).toEqual(bytes);
    expect(await panel.boundingBox()).toEqual(moved);
    await page.screenshot({ path: info.outputPath("desktop-video-moved.png") });
    await drag(page, panel, 1800, 1200); await reachable(page, panel);
    await drag(page, panel, -1800, -1200); await reachable(page, panel);
    await page.setViewportSize({ width: 800, height: 580 }); await reachable(page, panel);
    await page.setViewportSize({ width: 390, height: 844 });
    await expect.poll(() => panel.evaluate(node => node.style.translate)).toBe("");
    await page.setViewportSize({ width: 1440, height: 1000 });
    await drag(page, panel, -80, 30);
    await page.keyboard.press("Escape"); await expect(dialog).toHaveCount(0); await expect(opener).toBeFocused();
    await opener.click(); await expect(video).toBeVisible();
    await expect.poll(() => panel.evaluate(node => node.style.translate)).toBe("");
    const reopened = (await panel.boundingBox())!; expect(reopened.x).toBeCloseTo(original.x, 0); expect(reopened.y).toBeCloseTo(original.y, 0);
    await panel.getByRole("button", { name: "关闭", exact: true }).click(); await expect(opener).toBeFocused();
  });
});

test("desktop draft video uses the same drag handle and preserves the unsent draft", async ({ page }) => {
  await fixture(page, async (bytes, hub, chatId) => {
    const composer = page.getByRole("textbox", { name: "消息", exact: true }); await composer.fill("保留我的视频草稿");
    await page.locator('input[type="file"][multiple]').setInputFiles({ name: "draft.mp4", mimeType: "application/octet-stream", buffer: bytes });
    const opener = page.getByRole("button", { name: "预览 draft.mp4", exact: true }); await opener.click();
    const dialog = page.getByRole("dialog", { name: "附件预览", exact: true }), panel = dialog.locator(".file-preview");
    await expect.poll(() => dialog.locator("video").evaluate((node: HTMLVideoElement) => node.readyState)).toBeGreaterThanOrEqual(2);
    await expect(dialog.locator("video")).toHaveAttribute("poster", /^data:image\/jpeg;base64,/);
    expect(await dialog.locator("video").evaluate((node: HTMLVideoElement) => node.paused && node.currentTime === 0)).toBe(true);
    const before = (await panel.boundingBox())!;
    await drag(page, panel, -120, 40); const after = (await panel.boundingBox())!;
    expect(after.x - before.x).toBeCloseTo(-120, 0); expect(after.y - before.y).toBeCloseTo(40, 0);
    await panel.getByRole("button", { name: "关闭", exact: true }).click();
    // Desktop preview now returns to the composer so another paste works.
    await expect(composer).toBeFocused(); await expect(composer).toHaveValue("保留我的视频草稿");
    expect((await hub.store.snapshot("owner", chatId)).messages).toHaveLength(1);
  });
});

test("phone video stays fullscreen and does not turn touch gestures into window dragging", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, serviceWorkers: "block" });
  const page = await context.newPage();
  try { await fixture(page, async () => {
    await page.getByRole("region", { name, exact: true }).getByRole("button", { name: `预览 ${name}`, exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "文件预览", exact: true }), panel = dialog.locator(".file-preview");
    await expect(dialog.locator("video")).toBeVisible();
    for (const viewport of [{ width: 390, height: 844 }, { width: 844, height: 390 }]) {
      await page.setViewportSize(viewport); const before = await panel.boundingBox();
      await panel.locator("header").evaluate(node => {
        for (const [type, x, y] of [["pointerdown", 50, 20], ["pointermove", 120, 60], ["pointerup", 120, 60]] as const)
          node.dispatchEvent(new PointerEvent(type, { pointerId: 7, pointerType: "touch", isPrimary: true, button: 0, clientX: x, clientY: y, bubbles: true }));
      });
      expect(await panel.boundingBox()).toEqual(before); expect(await panel.evaluate(node => node.style.translate)).toBe("");
      expect(before).toMatchObject({ x: 0, y: 0, width: viewport.width, height: viewport.height });
    }
    await panel.getByRole("button", { name: "关闭", exact: true }).click(); await expect(dialog).toHaveCount(0);
  }); } finally { await context.close(); }
});
