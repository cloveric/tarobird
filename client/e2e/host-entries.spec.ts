import { test, expect } from "@playwright/test";
import type { ViteDevServer } from "vite";
import { createServer } from "./fixtures/vite.js";

let server: ViteDevServer;
test.beforeAll(async () => { server = await createServer({ server: { host: "127.0.0.1", port: 0 } }); await server.listen(); });
test.afterAll(async () => { await server?.close(); });
test.beforeEach(async ({ page }) => { await page.goto(server.resolvedUrls!.local[0] + "e2e/fixtures/host-entries.html"); });
const rows = (page: import("@playwright/test").Page) => page.locator(".saved-routes li");

test("the host's own list shows its listening LAN and Tailscale entries after 主机直连", async ({ page }) => {
  await expect(rows(page)).toHaveCount(3);
  await expect(rows(page).nth(0)).toContainText("当前使用");
  await expect(page.locator('[data-host-entry="lan"]')).toContainText("局域网");
  await expect(page.locator('[data-host-entry="lan"] .route-state')).toHaveText("已就绪");
  await expect(page.locator('[data-host-entry="tailscale"]')).toContainText("Tailscale");
  await expect(page.locator('[data-host-entry="tailscale"] .route-state')).toHaveText("已就绪");
  for (const width of [390, 1360]) {
    await page.setViewportSize({ width, height: 820 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
});

test("an enabled but non-listening Tailscale entry says it is waiting; a disabled one is not listed", async ({ page }) => {
  await page.evaluate(() => (window as any).hostEntriesFixture.set({ tailscale: { enabled: true, listening: false } }));
  await expect(page.locator('[data-host-entry="tailscale"] .route-state')).toHaveText("等待网络连接");
  await page.evaluate(() => (window as any).hostEntriesFixture.set({ tailscale: { enabled: false, listening: false } }));
  await expect(page.locator('[data-host-entry="tailscale"]')).toHaveCount(0);
  await expect(rows(page)).toHaveCount(2);
  await page.evaluate(() => (window as any).hostEntriesFixture.setLocale("en"));
  await expect(page.locator('[data-host-entry="lan"]')).toContainText("LAN");
  await expect(page.locator('[data-host-entry="lan"] .route-state')).toHaveText("Ready");
});
