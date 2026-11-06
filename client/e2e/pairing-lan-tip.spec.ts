import { test, expect } from "@playwright/test";
import type { ViteDevServer } from "vite";
import { createServer } from "./fixtures/vite.js";

// The host's 添加设备 pairing choice recommends a same-LAN first pairing.
// Uses the Tailscale pairing fixture's initial render only; no invite is made.
declare global { interface Window { tailscaleFixture: { render(): void; setLocale(locale: string): void } } }
let server: ViteDevServer;
test.beforeAll(async () => { server = await createServer({ server: { host: "127.0.0.1", port: 0 } }); await server.listen(); });
test.afterAll(async () => { await server?.close(); });
test.beforeEach(async ({ page }) => {
  await page.goto(server.resolvedUrls!.local[0] + "e2e/fixtures/tailscale-pairing.html");
  await page.waitForFunction(() => !!window.tailscaleFixture);
  await page.evaluate(() => window.tailscaleFixture.render());
});

test("host pairing choice recommends the same local network for the first pairing", async ({ page }) => {
  const tip = page.getByText("建议首次配对时，新设备和主机连在同一局域网（同一 Wi-Fi）下。", { exact: true });
  await expect(tip).toBeVisible();
  await page.getByRole("button", { name: "Tailscale 异地连接", exact: true }).click();
  await expect(tip).toBeVisible();
  await page.evaluate(() => window.tailscaleFixture.setLocale("en"));
  await expect(page.getByText("For the first pairing, we recommend putting the new device and the host on the same local network (the same Wi-Fi).", { exact: true })).toBeVisible();
});
