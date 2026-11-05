import { test, expect, type Page, type Locator } from "@playwright/test";
import { preparePairing } from "./fixtures/pairing-invite.js";
import { openSettings, openDevicePairing } from "./fixtures/settings.js";
import { waitForClientOnline } from "./fixtures/mobile.js";
import { noviceNetworkFixture } from "./fixtures/novice-network.js";
import { createServer } from "./fixtures/vite.js";

// Layout evidence for the compact add-device page and the network overview.
test.use({ serviceWorkers: "block" });
const widths = [{ width: 320, height: 760 }, { width: 390, height: 844 }, { width: 1360, height: 900 }];
const wizard = (page: Page) => page.getByRole("dialog", { name: "添加设备", exact: true });

async function contained(dialog: Locator) {
  expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  expect(await dialog.locator("button,select,img").evaluateAll(elements => elements.filter(element => element.getClientRects().length).every(element => {
    const rect = element.getBoundingClientRect(); return rect.left >= -1 && rect.right <= innerWidth + 1;
  }))).toBe(true);
}

async function phonePage(dialog: Locator, viewport: { width: number; height: number }) {
  if (viewport.width > 760) {
    expect((await dialog.boundingBox())!.width).toBeLessThan(1000);
    expect(await dialog.evaluate(node => parseFloat(getComputedStyle(node).borderTopLeftRadius))).toBeGreaterThan(0);
    return;
  }
  await expect.poll(() => dialog.evaluate(element => {
    const r = element.getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height), radius: getComputedStyle(element).borderTopLeftRadius };
  })).toEqual({ x: 0, y: 0, ...viewport, radius: "0px" });
}

test("the add-device page leads with one QR, its actions and validity at 320, 390 and desktop widths", async ({ page }, info) => {
  test.setTimeout(90_000);
  // Real disposable HTTPS Hubs, so the host offers a shareable route and a live invitation.
  const fixture = await noviceNetworkFixture();
  const hub = fixture.hubs[0]!;
  try {
    await page.setViewportSize(widths[1]!);
    await page.goto(fixture.phoneOrigin + "__novice?phone=1");
    await page.getByLabel("设备名称", { exact: true }).fill("布局验收设备");
    await page.getByLabel("Hub 地址", { exact: true }).fill(hub.url);
    await preparePairing(page, hub); await page.getByRole("button", { name: "配对此设备", exact: true }).click();
    await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
    await expect(page.getByLabel("配对码", { exact: true })).toBeHidden({ timeout: 20_000 });
    await waitForClientOnline(page);
    await openSettings(page, "devices");
    for (const viewport of widths) {
      await page.setViewportSize(viewport);
      await openDevicePairing(page, false, 0);
      const dialog = wizard(page);
      await expect(dialog.getByRole("heading", { name: "让新手机或电脑扫描二维码", exact: true })).toBeVisible();
      await expect(dialog.getByRole("img", { name: "连接二维码", exact: true })).toBeVisible();
      await phonePage(dialog, viewport);
      await expect(dialog.getByRole("button", { name: "复制连接信息", exact: true })).toBeVisible();
      await expect(dialog.getByRole("button", { name: "保存二维码图片", exact: true })).toBeVisible();
      await expect(dialog.getByRole("button", { name: "重新生成二维码", exact: true })).toBeVisible();
      await expect(dialog.getByRole("button", { name: "重新生成连接码", exact: true })).toHaveCount(0);
      await expect(dialog.getByText(/^二维码有效时间 \d:\d\d · 仅限一台新设备$/)).toBeVisible();
      await contained(dialog);
      await page.screenshot({ animations: "disabled", path: info.outputPath(`add-device-${viewport.width}.png`) });
      await dialog.getByRole("button", { name: "关闭添加设备", exact: true }).click();
      await expect(dialog).toHaveCount(0);
    }
  } finally { await page.close(); await fixture.close(); }
});

const html = '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/e2e/fixtures/network-manager.tsx"></script></body></html>';
test("network overview titles match host names and status dots share one column", async ({ page }, info) => {
  const vite = await createServer({ optimizeDeps: { entries: ["e2e/fixtures/network-manager.tsx"] }, plugins: [{ name: "network-layout-fixture", configureServer(server) { server.middlewares.use(async (request, response, next) => { if (request.url !== "/__network-layout") return next(); response.setHeader("Content-Type", "text/html"); response.end(await server.transformIndexHtml("/__network-layout", html)); }); } }], server: { host: "127.0.0.1", port: 0, hmr: false } });
  try {
    await vite.listen(); await page.goto(vite.resolvedUrls!.local[0]! + "__network-layout");
    const overview = page.getByRole("dialog", { name: "设备与网络", exact: true });
    await expect(overview).toBeVisible();
    await page.evaluate(() => { const fixture = (window as unknown as { networkFixture: { overview(names: string[]): void; authorityStatus(status: string): void } }).networkFixture; fixture.overview(["macmini", "ASUS"]); fixture.authorityStatus("connecting"); });
    const statuses = overview.locator(".network-member-status");
    await expect(statuses).toHaveCount(2);
    await expect(statuses.nth(0)).toContainText("连接中…"); await expect(statuses.nth(1)).toContainText("已连接");
    for (const viewport of widths) {
      await page.setViewportSize(viewport);
      await phonePage(overview, viewport);
      const dots = await statuses.locator("i").evaluateAll(items => items.map(item => Math.round(item.getBoundingClientRect().left)));
      expect(Math.max(...dots) - Math.min(...dots)).toBeLessThanOrEqual(1);
      const weights = await overview.evaluate(element => [element.querySelector(".network-invite-button strong"), element.querySelector(".network-summary-main h3")].map(node => node ? Number(getComputedStyle(node).fontWeight) : 0));
      expect(weights).toEqual([600, 400]);
      const sizes = await overview.locator(".network-invite-button strong,.network-summary-name,.network-sync-shortcut strong,.network-member-title strong").evaluateAll(nodes => nodes.map(node => getComputedStyle(node).fontSize));
      expect(new Set(sizes).size).toBe(1);
      await page.screenshot({ animations: "disabled", path: info.outputPath(`network-overview-${viewport.width}.png`) });
    }
  } finally { await page.close(); await vite.close(); }
});
