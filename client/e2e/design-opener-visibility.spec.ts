import { test, expect, type Page } from "@playwright/test";
import type { ViteDevServer } from "vite";
import { createServer } from "./fixtures/vite.js";
let server: ViteDevServer;
test.beforeAll(async () => { server = await createServer({ server: { host: "127.0.0.1", port: 0 } }); await server.listen(); });
test.afterAll(async () => { await server?.close(); });
async function open(page: Page, query = "") {
  await page.goto(server.resolvedUrls!.local[0] + "e2e/fixtures/design-opener-visibility.html" + query);
  await expect(page.getByText("Visibility hook mounted")).toBeVisible();
  expect(await page.evaluate(() => document.visibilityState)).toBe("visible");
}
const count = (page: Page) => page.evaluate(() => (window as any).designVisibility.registrations.size);
test("hidden native windows never advertise automatic opening; show restores a fresh endpoint", async ({ page }) => {
  await open(page, "?hidden"); expect(await count(page)).toBe(0);
  await page.evaluate(() => (window as any).designVisibility.emit({ visible: true, minimized: false }));
  await expect.poll(() => count(page)).toBe(1);
  const context = await page.evaluate(() => (window as any).designVisibility.context());
  expect(context.openTarget).toBeTruthy();
  // A hide queued in the same task must invalidate the command before its
  // admission microtask, even though document.visibilityState stays visible.
  await page.evaluate(() => { const f = (window as any).designVisibility; f.command(); f.emit({ visible: false, minimized: false }); });
  await expect.poll(() => count(page)).toBe(0);
  expect(await page.evaluate(() => (window as any).designVisibility.opens)).toBe(0);
  expect(await page.evaluate(() => (window as any).designVisibility.context())).toBeUndefined();
  await page.evaluate(() => (window as any).designVisibility.emit({ visible: true, minimized: false }));
  await expect.poll(() => count(page)).toBe(1);
  expect((await page.evaluate(() => (window as any).designVisibility.context())).openTarget.windowId).not.toBe(context.openTarget.windowId);
  await page.evaluate(() => (window as any).designVisibility.emit({ visible: true, minimized: true }));
  await expect.poll(() => count(page)).toBe(0);
});
test("a stale initial native read cannot resurrect an opener after hide", async ({ page }) => {
  await open(page, "?delayed"); expect(await count(page)).toBe(0);
  await page.evaluate(() => { const f = (window as any).designVisibility; f.emit({ visible: false, minimized: false }); f.resolveRead(); });
  expect(await count(page)).toBe(0);
  expect(await page.evaluate(() => (window as any).designVisibility.context())).toBeUndefined();
  await page.evaluate(() => (window as any).designVisibility.emit({ visible: true, minimized: false }));
  await expect.poll(() => count(page)).toBe(1);
});
test("unavailable native events fail closed without an unhandled error or blocking chat", async ({ page }) => {
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  await open(page, "?broken"); expect(await count(page)).toBe(0);
  expect(await page.evaluate(() => (window as any).designVisibility.context())).toBeUndefined(); expect(errors).toEqual([]);
});
test("browser and mobile pages retain their document visibility behaviour", async ({ page }) => {
  await open(page, "?web"); await expect.poll(() => count(page)).toBe(1);
  expect((await page.evaluate(() => (window as any).designVisibility.context())).openTarget).toBeTruthy();
});
