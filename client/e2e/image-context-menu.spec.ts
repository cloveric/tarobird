import { test, expect } from "@playwright/test";
import { createHash } from "node:crypto";
import { imageViewerFixture } from "./fixtures/image-viewer.js";

test("image menu stays above its modal, owns keyboard navigation and saves the selected original", async ({ page }, info) => {
  const env = await imageViewerFixture(page);
  try {
    await page.getByRole("button", { name: "第一张", exact: true }).click();
    const viewer = page.getByRole("dialog", { name: "图片预览", exact: true }), image = viewer.locator("img");
    await expect(image).toBeVisible();
    await image.click({ button: "right" });
    const menu = viewer.getByRole("menu", { name: "图片操作" });
    await expect(menu).toBeVisible();
    await expect(menu.getByRole("menuitem", { name: /复制图片/ })).toBeFocused();
    await page.keyboard.press("ArrowRight"); await expect(image).toHaveAttribute("alt", "第一张");
    await page.screenshot({ path: info.outputPath("image-context-menu.png") });
    await page.keyboard.press("ArrowDown");
    await expect(menu.getByRole("menuitem", { name: "另存为", exact: true })).toBeFocused();
    await expect(image).toHaveAttribute("alt", "第一张");
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0); await expect(viewer).toBeVisible();
    await expect(viewer.getByLabel("完整图片", { exact: true })).toBeFocused();
    await page.keyboard.press("ArrowRight"); await expect(image).toHaveAttribute("alt", "第二张");
    await page.keyboard.press("Shift+F10"); await expect(menu).toBeVisible();
    const download = page.waitForEvent("download");
    await menu.getByRole("menuitem", { name: "另存为", exact: true }).click();
    const file = await download, chunks: Buffer[] = [];
    for await (const chunk of (await file.createReadStream())!) chunks.push(Buffer.from(chunk));
    expect(Buffer.concat(chunks)).toEqual(env.originals[1]);
    await expect(menu).toHaveCount(0); await expect(viewer).toBeVisible();
    await page.keyboard.press("h");
    await image.click({ button: "right" }); await expect(menu).toBeVisible();
    await menu.getByRole("menuitem", { name: "放大图片", exact: true }).click();
    await expect(viewer.getByLabel("完整图片", { exact: true })).toHaveAttribute("data-zoomed", "true");
    await image.click({ button: "right" });
    await page.setViewportSize({ width: 900, height: 700 }); await expect(menu).toHaveCount(0);
    await page.keyboard.press("Escape"); await expect(viewer).toHaveCount(0);
  } finally { await page.close(); await env.close(); }
});

test("copy writes the full selected image to the clipboard and pastes into the composer", async ({ page, context, browserName }) => {
  test.skip(browserName !== "chromium", "Chromium clipboard permissions permit automated system clipboard readback; WebKit has native fixture acceptance.");
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const env = await imageViewerFixture(page);
  try {
    await page.getByRole("button", { name: "第一张", exact: true }).click();
    const viewer = page.getByRole("dialog", { name: "图片预览", exact: true });
    await expect(viewer.locator("img")).toBeVisible();
    await page.keyboard.press("ArrowRight");
    await expect(viewer.locator("img")).toHaveAttribute("alt", "第二张");
    await viewer.getByRole("button", { name: "放大图片", exact: true }).click();
    await viewer.locator("img").click({ button: "right" });
    await viewer.getByRole("menuitem", { name: /复制图片/ }).click();
    await expect(viewer.getByRole("status")).toHaveText("图片已复制");
    const dimensions = await page.evaluate(async () => {
      const item = (await navigator.clipboard.read())[0]!;
      const png = await item.getType("image/png"), bitmap = await createImageBitmap(png);
      const size = [bitmap.width, bitmap.height]; bitmap.close(); return size;
    });
    expect(dimensions).toEqual([1200, 1200]);
    await page.keyboard.press("Escape");
    const composer = page.locator(".composer textarea"); await composer.focus();
    await page.keyboard.press(process.platform === "darwin" ? "Meta+v" : "Control+v");
    await expect(page.locator(".attachment-draft img")).toHaveCount(1);
  } finally { await page.close(); await env.close(); }
});

for (const format of ["image/jpeg", "image/svg+xml"]) test(`copy converts ${format} to full-size PNG in the original user gesture`, async ({ page }) => {
  const env = await imageViewerFixture(page);
  try {
    const bytes = format === "image/svg+xml" ? Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="240" height="180"><rect width="240" height="180" fill="#b23432"/></svg>')
      : Buffer.from(await page.evaluate(() => { const canvas = document.createElement("canvas"); canvas.width = 240; canvas.height = 180; const ctx = canvas.getContext("2d")!; ctx.fillStyle = "#b23432"; ctx.fillRect(0, 0, 240, 180); return canvas.toDataURL("image/jpeg").split(",")[1]!; }), "base64");
    const attachmentId = await env.hub.attachments.importForBot("photo", { conversationId: env.chat.id, name: "copy-source", mime: format, size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") }, bytes);
    await env.hub.store.publishBotMessage("photo", { conversationId: env.chat.id, blocks: [{ type: "image", attachmentId, title: "转换图片" }] });
    await page.evaluate(() => {
      Object.defineProperty(navigator.clipboard, "write", { configurable: true, value: async (items: ClipboardItem[]) => {
        const active = navigator.userActivation.isActive;
        const blob = await items[0]!.getType("image/png"), image = new Image(), url = URL.createObjectURL(blob);
        try { image.src = url; await image.decode(); (window as any).__imageCopy = { active, type: blob.type, width: image.naturalWidth, height: image.naturalHeight }; }
        finally { URL.revokeObjectURL(url); }
      } });
    });
    await page.getByRole("button", { name: "转换图片", exact: true }).click();
    const viewer = page.getByRole("dialog", { name: "图片预览", exact: true }); await expect(viewer.locator("img")).toBeVisible();
    await page.keyboard.press(process.platform === "darwin" ? "Meta+c" : "Control+c");
    await expect(viewer.getByRole("status")).toHaveText("图片已复制");
    expect(await page.evaluate(() => (window as any).__imageCopy)).toEqual({ active: true, type: "image/png", width: 240, height: 180 });
  } finally { await page.close(); await env.close(); }
});

test("copy failure is visible and a late copy receipt cannot label another image as copied", async ({ page }) => {
  const env = await imageViewerFixture(page);
  try {
    await page.evaluate(() => { Object.defineProperty(navigator.clipboard, "write", { configurable: true, value: () => Promise.reject(new Error("denied")) }); });
    await page.getByRole("button", { name: "第一张", exact: true }).click();
    const viewer = page.getByRole("dialog", { name: "图片预览", exact: true }); await expect(viewer.locator("img")).toBeVisible();
    const copy = async () => { await viewer.locator("img").click({ button: "right" }); await viewer.getByRole("menuitem", { name: /复制图片/ }).click(); };
    await copy(); await expect(viewer.getByRole("alert")).toHaveText("无法复制图片，请重试或另存为。");
    await page.evaluate(() => { Object.defineProperty(navigator.clipboard, "write", { configurable: true, value: () => new Promise<void>(resolve => { (window as any).__finishCopy = resolve; }) }); });
    await copy(); await expect(viewer.getByRole("status")).toHaveText("正在复制图片…");
    await page.keyboard.press("ArrowRight"); await expect(viewer.locator("img")).toHaveAttribute("alt", "第二张");
    await page.evaluate(() => (window as any).__finishCopy());
    await expect(viewer.getByText("图片已复制", { exact: true })).toHaveCount(0);
    await expect(viewer).toBeVisible();
  } finally { await page.close(); await env.close(); }
});
