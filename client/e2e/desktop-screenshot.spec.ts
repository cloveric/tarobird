import { test, expect } from "@playwright/test";
import type { ViteDevServer } from "vite";
import { createServer } from "./fixtures/vite.js";
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jI1EAAAAASUVORK5CYII=";
let server: ViteDevServer;
test.beforeAll(async () => { server = await createServer({ server: { host: "127.0.0.1", port: 0 } }); await server.listen(); });
test.afterAll(async () => { await server?.close(); });
for (const engine of ["tauri", "electron"]) test.describe(engine, () => {
test.beforeEach(async ({ page }) => {
  await page.goto(server.resolvedUrls!.local[0] + `e2e/fixtures/desktop-screenshot.html?engine=${engine}`);
  await page.waitForFunction(() => !!(window as any).screenshotFixture);
});

test("desktop selection becomes a removable thumbnail alongside the caption; cancel preserves both", async ({ page }, info) => {
  const attach = page.getByRole("button", { name: "Attach", exact: true });
  const menu = page.getByRole("group", { name: "添加附件", exact: true });
  const tray = page.getByRole("region", { name: "待发送的附件", exact: true });
  await page.getByRole("textbox", { name: "Message" }).fill("帮我看这个截图");
  await attach.click(); await expect(menu).toBeInViewport();
  await expect(menu.getByRole("button", { name: "上传附件", exact: true })).toBeFocused();
  await page.keyboard.press("ArrowDown"); await expect(menu.getByRole("button", { name: /^截屏/ })).toBeFocused();
  await page.screenshot({ path: info.outputPath("desktop-screenshot-menu.png"), animations: "disabled" });
  await page.keyboard.press("Enter"); await expect(menu).toHaveCount(0); await expect(attach).toBeDisabled();
  expect(await page.evaluate(() => (window as any).screenshotFixture.calls)).toEqual([{ english: false }]);
  await page.evaluate(png => (window as any).screenshotFixture.finish(png), png);
  await expect(tray.getByRole("listitem")).toHaveCount(1);
  await expect(attach).toBeEnabled();
  await expect(page.getByRole("textbox", { name: "Message" })).toHaveValue("帮我看这个截图");
  await expect(page.getByLabel("Sent messages")).toHaveText("0");
  const files = await page.evaluate(() => (window as any).screenshotFixture.files());
  expect(files[0].type).toBe("image/png"); expect(files[0].data).toEqual([...Buffer.from(png, "base64")]);
  await expect(tray.locator("img")).toBeVisible();
  expect(await tray.locator("img").evaluate(e => e.getBoundingClientRect().height)).toBeLessThanOrEqual(120);
  await attach.click(); await menu.getByRole("button", { name: /^截屏/ }).click();
  await page.evaluate(() => (window as any).screenshotFixture.finish(null));
  await expect(attach).toBeEnabled(); await expect(tray.getByRole("listitem")).toHaveCount(1); await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: "Message" })).toBeFocused();
  await attach.click(); const chooser = page.waitForEvent("filechooser"); await menu.getByRole("button", { name: "上传附件", exact: true }).click();
  await (await chooser).setFiles({ name: "details.txt", mimeType: "text/plain", buffer: Buffer.from("details") });
  await expect(tray.getByRole("listitem")).toHaveCount(2);
  await tray.getByRole("button", { name: /^移除 Screenshot/ }).click(); await expect(tray.getByRole("listitem")).toHaveCount(1);
  await expect(page.getByLabel("Sent messages")).toHaveText("0");
});

for (const destination of ["chat", "host", "search"] as const) test(`a late capture is discarded after ${destination} changes and returns`, async ({ page }) => {
  await page.getByRole("button", { name: "Attach", exact: true }).click();
  await page.getByRole("button", { name: /^截屏/ }).click();
  await page.evaluate(destination => { const f = (window as any).screenshotFixture; if (destination === "chat") f.setScope("B"); else if (destination === "host") f.setHostActive(false); else f.setActive(false); }, destination);
  await expect(page.locator('main')).toHaveAttribute(destination === 'chat' ? 'data-scope' : destination === 'host' ? 'data-host-active' : 'data-active', destination === 'chat' ? 'B' : 'false');
  await page.evaluate(destination => { const f = (window as any).screenshotFixture; if (destination === "chat") f.setScope("A"); else if (destination === "host") f.setHostActive(true); else f.setActive(true); }, destination);
  await expect(page.locator('main')).toHaveAttribute(destination === 'chat' ? 'data-scope' : destination === 'host' ? 'data-host-active' : 'data-active', destination === 'chat' ? 'A' : 'true');
  await page.evaluate(png => (window as any).screenshotFixture.finish(png), png);
  await expect(page.getByRole("button", { name: "Attach", exact: true })).toBeEnabled();
  await expect(page.getByRole("region", { name: "待发送的附件", exact: true })).toHaveCount(0);
});

test("permission failure explains recovery; retry, English, Escape and phone fallback work", async ({ page }) => {
  const attach = page.getByRole("button", { name: "Attach", exact: true });
  await attach.click(); await page.getByRole("button", { name: /^截屏/ }).click();
  await page.evaluate(() => (window as any).screenshotFixture.fail("screenshot_permission_denied"));
  await expect(page.getByRole("alert")).toContainText("隐私与安全性"); await expect(attach).toBeEnabled();
  await page.evaluate(() => (window as any).screenshotFixture.setLocale("en"));
  await attach.click(); await page.getByRole("button", { name: /^Screenshot/ }).click();
  expect(await page.evaluate(() => (window as any).screenshotFixture.calls.at(-1))).toEqual({ english: true });
  await page.evaluate(() => (window as any).screenshotFixture.finish(null));
  await expect(attach).toBeEnabled(); await attach.click(); await page.keyboard.press("Escape"); await expect(page.getByRole("textbox", { name: "Message" })).toBeFocused();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => (window as any).screenshotFixture.setPhone(true));
  await attach.click(); await expect(page.getByRole("dialog", { name: "Add attachments", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /^Screenshot/ })).toHaveCount(0);
});

});
