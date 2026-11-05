import { test, expect, type Locator } from "@playwright/test";
import { imageViewerFixture } from "./fixtures/image-viewer.js";

const noTapOverlay = (node: Locator) => expect(node).toHaveCSS("-webkit-tap-highlight-color", "rgba(0, 0, 0, 0)");

for (const theme of ["light", "dark"]) test(`touch image opening has no lingering highlight and keeps keyboard navigation (${theme})`, async ({ browser }, info) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const page = await context.newPage(), env = await imageViewerFixture(page);
  try {
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
    const opener = page.getByRole("button", { name: "第一张", exact: true });
    // Check the actual hit target as well as its button. Native tap feedback is
    // inherited and is painted outside the DOM, even above a newly opened dialog.
    await noTapOverlay(opener); await noTapOverlay(opener.locator("img"));
    await opener.tap();
    const viewer = page.getByRole("dialog", { name: "图片预览", exact: true });
    await page.screenshot({ path: info.outputPath(`immediate-open-${theme}.png`) });
    await expect(viewer).toBeVisible();
    await expect(viewer.locator(".image-preview-title")).toBeFocused();
    await noTapOverlay(viewer.locator("img"));
    await noTapOverlay(viewer.getByLabel("完整图片", { exact: true }));
    const close = viewer.getByRole("button", { name: "关闭", exact: true });
    await noTapOverlay(close);
    await page.keyboard.press("Tab");
    await expect(close).toBeFocused();
    await expect(close).toHaveCSS("outline-style", "solid");
    await page.keyboard.press("Escape");
    await expect(viewer).toHaveCount(0); await expect(opener).toBeFocused();

    // Cover the owner's compact long-image thumbnail, including its overlay
    // label. Upload/send through the real composer into the isolated fixture.
    const chooser = page.waitForEvent("filechooser");
    await page.getByRole("button", { name: "添加附件", exact: true }).click();
    await page.getByRole("dialog", { name: "添加附件", exact: true }).getByRole("button", { name: "附加图片", exact: true }).click();
    await (await chooser).setFiles({ name: "触摸长图.png", mimeType: "image/png", buffer: env.originals[2]! });
    await page.getByRole("button", { name: "发送消息", exact: true }).click();
    const longOpener = page.locator(".message.user").last().getByRole("button", { name: "触摸长图.png", exact: true });
    const label = longOpener.getByText("长图 · 点击查看", { exact: true });
    await expect(label).toBeVisible();
    await noTapOverlay(longOpener); await noTapOverlay(label); await noTapOverlay(longOpener.locator("img"));
    await longOpener.tap();
    await expect(viewer.locator("img")).toBeVisible();
    await page.screenshot({ path: info.outputPath(`long-image-open-${theme}.png`) });
    await close.tap();
    await expect(viewer).toHaveCount(0); await expect(longOpener).toBeFocused();
    await expect(longOpener).toHaveCSS("outline-style", "none");
  } finally { await context.close(); await env.close(); }
});
