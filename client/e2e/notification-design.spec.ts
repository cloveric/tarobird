import { test, expect } from "@playwright/test";
import { createServer } from "./fixtures/vite.js";
import { openQuietHours } from "./fixtures/settings.js";
import type { ViteDevServer } from "vite";
import { fileURLToPath } from "node:url";

let server: ViteDevServer;
test.beforeAll(async () => {
  server = await createServer({ resolve: { alias: [
    { find: /^@capacitor\/core$/, replacement: fileURLToPath(new URL("./fixtures/notification-readiness-core.ts", import.meta.url)) },
    { find: /^@capacitor\/push-notifications$/, replacement: fileURLToPath(new URL("./fixtures/notification-readiness-push.ts", import.meta.url)) },
  ] }, server: { host: "127.0.0.1", port: 0, strictPort: false } });
  await server.listen();
});
test.afterAll(async () => { await server?.close(); });
const open = async (page: any, query = "") => {
  await page.goto(server.resolvedUrls!.local[0] + "e2e/fixtures/notification-readiness.html?permission=granted&" + query);
  await page.waitForFunction(() => !!window.readinessFixture);
};
const toggle = (page: any, name: string) => page.getByRole("switch", { name, exact: true });

for (const [platform, width, theme] of [["android", 390, "light"], ["ios", 390, "light"], ["macos", 1200, "light"], ["windows", 1000, "dark"], ["ios", 320, "dark"]] as const) {
  test(`notification settings are readable and operable on ${platform} ${width} ${theme}`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 900 }); await open(page, `platform=${platform}&theme=${theme}`);
    await expect(toggle(page, "消息提醒")).toHaveAttribute("aria-checked", "true");
    for (const label of ["回复完成", "收到文件", "需要处理", "显示消息详情"]) {
      await expect(toggle(page, label)).toBeVisible();
      const box = await toggle(page, label).boundingBox();
      expect(box!.width).toBeGreaterThanOrEqual(44); expect(box!.height).toBeGreaterThanOrEqual(44);
    }
    await expect(page.locator("details.notification-quiet")).not.toHaveAttribute("open");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await toggle(page, "显示消息详情").press("Space");
    await expect(toggle(page, "显示消息详情")).toHaveAttribute("aria-checked", "false");
    await expect.poll(() => page.evaluate(() => window.readinessFixture.connection.state.notifications.preferences.showPreview)).toBe(false);
    const desktop = ["macos", "windows"].includes(platform);
    await expect(page.getByText(desktop ? "使用其他应用时接收系统通知；点按通知回到对应对话。完全退出 TaroBird 后不再提醒。" : "离开 TaroBird 或锁屏后接收系统通知；点按通知回到对应对话。", { exact: true })).toBeVisible();
    await page.locator(".settings-group-heading").first().click();
    await page.screenshot({ path: info.outputPath(`${platform}-${width}-${theme}.png`), fullPage: true });
  });
}

test("a failed category write keeps the accepted switch and a later success preserves quiet-hour drafts", async ({ page }) => {
  await open(page, "platform=android");
  await openQuietHours(page);
  await page.getByLabel("勿扰开始", { exact: true }).fill("22:00");
  await page.getByLabel("勿扰结束", { exact: true }).fill("07:00");
  await page.evaluate(() => { window.readinessFixture.fixture.holdPreferences = true; window.readinessFixture.fixture.rejectPreferences = true; });
  await toggle(page, "回复完成").click();
  await expect(toggle(page, "回复完成")).toBeDisabled();
  await expect(page.locator("#notification-master-detail")).toHaveText("已开启");
  await expect(toggle(page, "回复完成")).toHaveAttribute("aria-checked", "true");
  await page.evaluate(() => { const f = window.readinessFixture.fixture; f.holdPreferences = false; f.preferenceReleases.splice(0).forEach((r: () => void) => r()); });
  await expect(page.getByRole("alert")).toHaveText("preferences_write_failed");
  await expect(toggle(page, "回复完成")).toHaveAttribute("aria-checked", "true");
  await page.evaluate(() => { window.readinessFixture.fixture.rejectPreferences = false; });
  await toggle(page, "回复完成").click();
  await expect(toggle(page, "回复完成")).toHaveAttribute("aria-checked", "false");
  await expect(page.getByLabel("勿扰开始", { exact: true })).toHaveValue("22:00");
  await expect(page.getByLabel("勿扰结束", { exact: true })).toHaveValue("07:00");
  await expect(toggle(page, "收到文件")).toHaveAttribute("aria-checked", "true");
  await expect.poll(() => page.evaluate(() => window.readinessFixture.connection.state.notifications.preferences.enabled)).toBe(true);
});

test("an older host exposes no unsupported category or preview controls", async ({ page }) => {
  await open(page, "platform=android&customization=false");
  await expect(toggle(page, "回复完成")).toHaveCount(0);
  await expect(toggle(page, "显示消息详情")).toHaveCount(0);
  await expect(page.getByText("更新主机后，可分别选择提醒内容和隐藏消息详情。", { exact: true })).toBeVisible();
  await toggle(page, "消息提醒").click();
  await expect(toggle(page, "消息提醒")).toHaveAttribute("aria-checked", "false");
  const writes = await page.evaluate(() => window.readinessFixture.fixture.writes);
  expect(writes).toHaveLength(1);
  expect(Object.keys(writes[0].body).sort()).toEqual(["enabled", "quietEnd", "quietStart", "timeZone"]);
});

for (const platform of ["android", "ios", "macos", "windows"]) test(`system settings stays accessible with reminders off and never changes consent on ${platform}`, async ({ page }) => {
  await open(page, `platform=${platform}&enabled=false`);
  const link = page.getByRole("button", { name: platform === "android" ? "声音与振动设置" : platform === "ios" ? "声音与锁屏设置" : "声音与横幅设置", exact: true });
  await expect(link).toBeEnabled();
  await link.click();
  await expect.poll(() => page.evaluate(() => window.readinessFixture.nativeState.calls.some((x: string) => x === "settings" || x.includes("settings")))).toBe(true);
  expect(await page.evaluate(() => window.readinessFixture.fixture.writes)).toEqual([]);
  await expect(toggle(page, "消息提醒")).toHaveAttribute("aria-checked", "false");
  await page.evaluate(() => { window.readinessFixture.nativeState.settingsFail = true; });
  await link.click();
  await expect(page.getByRole("alert")).toContainText(platform === "android" ? "无法打开系统设置" : "设置");
});

test("preparing event choices while reminders are off does not register push or turn them on", async ({ page }) => {
  await open(page, "platform=android&enabled=false");
  await toggle(page, "需要处理").click();
  await expect(toggle(page, "需要处理")).toHaveAttribute("aria-checked", "false");
  await expect(toggle(page, "消息提醒")).toHaveAttribute("aria-checked", "false");
  expect(await page.evaluate(() => window.readinessFixture.fixture.writes.map((w: any) => w.route))).toEqual(["/api/notifications"]);
  expect(await page.evaluate(() => window.readinessFixture.nativeState.calls)).not.toContain("TOKEN");
});

for (const platform of ["macos", "windows"]) test(`blocked desktop permission gives a recovery action without re-requesting on ${platform}`, async ({ page }, info) => {
  await page.setViewportSize({ width: 1000, height: 900 });
  await open(page, `platform=${platform}&enabled=false`);
  await page.evaluate(() => { window.readinessFixture.nativeState.permission = "denied"; });
  await openQuietHours(page);
  await page.getByLabel("勿扰开始", { exact: true }).fill("22:00");
  await toggle(page, "消息提醒").click();
  expect(await page.evaluate(() => window.readinessFixture.nativeState.calls)).not.toContain("permission-request");
  await expect(page.getByRole("alert")).toContainText("系统通知已关闭");
  const recovery = page.locator(".notification-permission-help");
  await expect(recovery).toContainText(platform === "macos" ? "系统设置 → 通知 → TaroBird" : "Windows 设置 → 系统 → 通知 → TaroBird");
  await expect(recovery).toContainText("返回此页重新开启消息提醒");
  await expect(toggle(page, "消息提醒")).toHaveAttribute("aria-checked", "false");
  await page.screenshot({ path: info.outputPath(`${platform}-permission-recovery.png`), fullPage: true });
  await recovery.getByRole("button", { name: "前往系统设置", exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.readinessFixture.nativeState.calls.includes("settings"))).toBe(true);
  expect(await page.evaluate(() => window.readinessFixture.fixture.writes)).toEqual([]);
  await page.evaluate(() => { window.readinessFixture.nativeState.settingsFail = true; });
  await recovery.getByRole("button", { name: "前往系统设置", exact: true }).click();
  await expect(recovery.getByRole("alert")).toContainText("设置");
  await page.evaluate(() => { window.readinessFixture.nativeState.permission = "granted"; });
  await toggle(page, "消息提醒").click();
  await expect(toggle(page, "消息提醒")).toHaveAttribute("aria-checked", "true");
  await expect(recovery).toHaveCount(0);
  await expect(page.getByLabel("勿扰开始", { exact: true })).toHaveValue("22:00");
  expect(await page.evaluate(() => window.readinessFixture.fixture.writes)).toHaveLength(1);
});

for (const phase of ["read", "request"]) test(`desktop permission ${phase} errors retain an actionable path without claiming enabled`, async ({ page }) => {
  await open(page, `platform=macos&enabled=false&${phase === "read" ? "permissionError" : "requestError"}=native_notification_permission_failed`);
  await page.evaluate(() => { window.readinessFixture.nativeState.permission = "prompt"; });
  await toggle(page, "消息提醒").click();
  await expect(page.getByRole("alert")).toContainText("系统通知");
  await expect(page.locator(".notification-permission-help").getByRole("button", { name: "前往系统设置", exact: true })).toBeVisible();
  await expect(toggle(page, "消息提醒")).toHaveAttribute("aria-checked", "false");
  expect(await page.evaluate(() => window.readinessFixture.fixture.writes)).toEqual([]);
});

test("a desktop Host save failure does not misdirect granted permission to OS recovery", async ({ page }) => {
  await open(page, "platform=macos&enabled=false");
  await page.evaluate(() => { window.readinessFixture.fixture.rejectPreferences = true; });
  await toggle(page, "消息提醒").click();
  await expect(page.getByRole("alert")).toHaveText("preferences_write_failed");
  await expect(page.locator(".notification-permission-help")).toHaveCount(0);
  await expect(toggle(page, "消息提醒")).toHaveAttribute("aria-checked", "false");
  expect(await page.evaluate(() => window.readinessFixture.nativeState.calls)).not.toContain("permission-request");
  expect(await page.evaluate(() => window.readinessFixture.fixture.writes)).toHaveLength(1);
});

test("a delayed system-settings receipt does not become a false failure and late success clears the fallback", async ({ page }) => {
  await page.clock.install(); await open(page, "platform=ios&enabled=false");
  await page.evaluate(() => { window.readinessFixture.fixture.holdSystem = true; });
  await page.getByRole("button", { name: "声音与锁屏设置", exact: true }).click();
  await page.clock.runFor(10_001);
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(page.getByText("也可手动打开系统设置，选择「通知 → TaroBird」。", { exact: true })).toBeVisible();
  await page.evaluate(() => window.readinessFixture.fixture.systemReleases.splice(0).forEach((release: () => void) => release()));
  await expect(page.getByText("也可手动打开系统设置，选择「通知 → TaroBird」。", { exact: true })).toHaveCount(0);
  await expect(toggle(page, "消息提醒")).toHaveAttribute("aria-checked", "false");
});

test("reception diagnostics respect manual collapse on both a warning and a ready state", async ({ page }) => {
  await open(page, "platform=android&configured=false");
  const details = page.locator("details.notification-readiness");
  await expect(page.getByText("主机推送尚未配置", { exact: true })).toBeVisible();
  await expect(details).toHaveAttribute("open");
  await details.locator("summary").click();
  await expect(details).not.toHaveAttribute("open");
  await page.evaluate(() => window.readinessFixture.publish());
  await expect(details).not.toHaveAttribute("open");
  await details.locator("summary").click();
  await expect(details).toHaveAttribute("open");
  await open(page, "platform=android");
  await expect(page.getByText("接收条件已就绪", { exact: true })).toBeVisible();
  await expect(details).not.toHaveAttribute("open");
  await details.locator("summary").click();
  await page.getByRole("button", { name: "检查接收状态", exact: true }).click();
  await expect(page.getByText("接收条件已就绪", { exact: true })).toBeVisible();
  await expect(details).toHaveAttribute("open");
});
