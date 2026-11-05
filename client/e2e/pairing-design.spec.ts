import { test, expect } from "@playwright/test";
import { createServer } from "./fixtures/vite.js";

for (const platform of ["macos", "windows"]) test(`desktop ${platform} pending setup has a visible return path in the real layout`, async ({ page }) => {
  const server = await createServer({ server: { port: 0, strictPort: false, host: "127.0.0.1" } }); await server.listen();
  try {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(`${server.resolvedUrls!.local[0]}e2e/fixtures/pairing-design.html?platform=${platform}&pending=1`);
    const back = page.getByRole("button", { name: "返回开始", exact: true });
    await expect(back).toBeInViewport();
    await back.click();
    await expect(page.getByRole("heading", { name: "从这台电脑开始" })).toBeInViewport();
    await page.getByRole("button", { name: "继续连接已有主机", exact: true }).click();
    await expect(page.getByLabel("配对码", { exact: true })).toHaveText("12345678");
    await expect(back).toBeInViewport();
  } finally { await server.close(); }
});

for (const locale of ["zh", "en"]) test(`first-run choices and phone scanner fit without horizontal scrolling (${locale})`, async ({ page }) => {
  const server = await createServer({ server: { port: 0, strictPort: false, host: "127.0.0.1" } }); await server.listen();
  const base = server.resolvedUrls!.local[0] + "e2e/fixtures/pairing-design.html";
  const fits = async () => expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  try {
    await page.setViewportSize({ width: 1200, height: 800 });
    await page.goto(`${base}?lang=${locale}`);
    const host = page.getByRole("button", { name: locale === "zh" ? "将这台电脑设为主机" : "Use this computer as a host", exact: true });
    await expect(host).toBeVisible();
    expect((await page.locator(".desktop-welcome").boundingBox())!.width).toBeGreaterThan(500);
    await fits();
    for (const width of [320, 390]) {
      await page.setViewportSize({ width, height: 844 });
      await page.goto(`${base}?view=phone&lang=${locale}`);
      const scan = page.getByRole("button", { name: locale === "zh" ? "扫描连接二维码" : "Scan connection QR code", exact: true });
      await expect(scan).toBeVisible();
      const scanRect = (await scan.boundingBox())!;
      expect(scanRect.y + scanRect.height).toBeLessThanOrEqual(844);
      expect(scanRect.height).toBeGreaterThanOrEqual(44);
      await expect(page.getByRole("textbox")).toHaveCount(0);
      await fits();
      await scan.click();
      const sheet = page.getByRole("dialog"); await expect(sheet).toBeVisible();
      const rect = (await sheet.boundingBox())!;
      expect(rect.x).toBeGreaterThanOrEqual(0); expect(rect.x + rect.width).toBeLessThanOrEqual(width + 1);
      const image = page.locator(".scanner-image-button"), imageRect = (await image.boundingBox())!;
      expect(imageRect.height).toBeGreaterThanOrEqual(44);
      await expect.poll(async () => { const settled = (await image.boundingBox())!; return settled.y + settled.height; }).toBeLessThanOrEqual(844);
      await expect(page.locator("video")).toBeHidden();
      await page.keyboard.press("Escape"); await expect(sheet).toHaveCount(0); await expect(scan).toBeFocused();
    }
  } finally { await server.close(); }
});
