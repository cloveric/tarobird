import { test, expect } from "@playwright/test";
import type { ViteDevServer } from "vite";
import { createServer } from "./fixtures/vite.js";

let server: ViteDevServer;
test.beforeAll(async () => { server = await createServer({ server: { host: "127.0.0.1", port: 0 } }); await server.listen(); });
test.afterAll(async () => { await server?.close(); });
test.beforeEach(async ({ page }) => { await page.goto(server.resolvedUrls!.local[0] + "e2e/fixtures/multipath-routes.html"); });

for (const width of [390, 1360]) test(`LAN, Tailscale and relay survive save/reload without losing trust (${width})`, async ({ page }, info) => {
  await page.setViewportSize({ width, height: 920 });
  await page.getByRole("button", { name: "编辑线路", exact: true }).click();
  const vpn = page.getByLabel("主机的 Tailscale 连接地址（可选）", { exact: true });
  // Typing into an initially absent route must not remount and lose focus.
  await vpn.pressSequentially("https://100.80.1.20:8788");
  await expect(vpn).toBeFocused(); await expect(vpn).toHaveValue("https://100.80.1.20:8788");
  await page.getByRole("button", { name: "保存线路", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("线路已保存");
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem("fixture-routes")!));
  expect(saved).toHaveLength(3);
  expect(saved.find((route: any) => route.name === "Direct").certificateAuthority).toBe("A".repeat(120));
  expect(saved.find((route: any) => route.name === "VPS").certificateAuthority).toBe("B".repeat(120));
  expect(saved.find((route: any) => route.name === "Tailscale").certificateAuthority).toBeUndefined();
  await page.reload(); await expect(page.locator(".saved-routes li")).toHaveCount(3);
  await page.getByRole("button", { name: "编辑线路", exact: true }).click(); await expect(vpn).toHaveValue("https://100.80.1.20:8788");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath(`multipath-${width}.png`), fullPage: true });
});

test("failed save and concurrent automatic updates never falsely succeed or discard saved routes", async ({ page }) => {
  await page.getByRole("button", { name: "编辑线路", exact: true }).click();
  await page.getByLabel("主机的 Tailscale 连接地址（可选）", { exact: true }).fill("https://100.80.1.20:8788");
  await page.evaluate(() => { (window as any).multipathFixture.data.fail = true; });
  await page.getByRole("button", { name: "保存线路", exact: true }).click();
  await expect(page.getByRole("alert")).toHaveText("测试：保存失败");
  expect(await page.evaluate(() => localStorage.getItem("fixture-routes"))).toBeNull();
  await page.evaluate(() => { const fixture = (window as any).multipathFixture; fixture.data.fail = false; fixture.externalUpdate(); });
  await page.getByRole("button", { name: "保存线路", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("主机线路刚刚更新");
  expect(await page.evaluate(() => (window as any).multipathFixture.data.saves)).toBe(0);
  await page.getByRole("button", { name: "取消", exact: true }).click();
  await page.getByRole("button", { name: "编辑线路", exact: true }).click();
  await expect(page.getByLabel("主机的 Tailscale 连接地址（可选）", { exact: true })).toHaveValue("https://100.80.1.21:8788");
});

test("route synchronization preserves enrollment and refuses stale, revoked or replaced cache identities", async ({ page }) => {
  expect(await page.evaluate(() => (window as any).verifyRouteStorage())).toEqual({
    retained: true, stale: "routes_changed", revoked: "device_revoked", replaced: "host_cache_identity_mismatch", owner: "new-owner",
  });
});

test("host listener status distinguishes an enabled but non-listening Tailscale endpoint", async ({ page }) => {
  await page.evaluate(() => (window as any).showHostRouteStatus());
  await page.getByText("主机入口状态", { exact: true }).click();
  const status = page.locator(".host-route-status");
  await expect(status).toContainText("已开启，正在监听");
  await expect(status).toContainText("已开启，当前未监听");
  await expect(status).toContainText("手机仍需开启 Tailscale");
  await expect(status).toContainText("请确认主机上的 Tailscale 已连接");
});

test("shows when a host route cannot be added because local routes are full", async ({ page }) => {
  await page.evaluate(() => (window as any).showHostRouteStatus(true));
  await expect(page.getByRole("status")).toContainText("线路数量已达上限");
  await expect(page.getByRole("status")).toContainText("上次同步");
  await expect(page.locator(".saved-routes li")).toHaveCount(4);
});

test("a deliberately deleted host route does not produce a false full-route warning", async ({ page }) => {
  await page.evaluate(() => (window as any).showHostRouteStatus(true, true));
  await expect(page.locator(".host-route-status")).toBeVisible();
  await expect(page.getByText(/上次同步时线路数量已达上限/)).toHaveCount(0);
  await expect(page.locator(".saved-routes li")).toHaveCount(4);
});
