import { openQuietHours } from "./fixtures/settings.js";
import { test, expect } from "@playwright/test";
import { createServer } from "./fixtures/vite.js";
import type { ViteDevServer } from "vite";
import { fileURLToPath } from "node:url";
declare global { interface Window { readinessFixture: any } }
let server: ViteDevServer;
test.beforeAll(async () => { server = await createServer({ resolve: { alias: [
 { find: /^@capacitor\/core$/, replacement: fileURLToPath(new URL("./fixtures/notification-readiness-core.ts", import.meta.url)) },
 { find: /^@capacitor\/push-notifications$/, replacement: fileURLToPath(new URL("./fixtures/notification-readiness-push.ts", import.meta.url)) },
 { find: /^@capacitor\/app$/, replacement: fileURLToPath(new URL("./fixtures/notification-readiness-app.ts", import.meta.url)) },
] }, server: { host: "127.0.0.1", port: 0, strictPort: false } }); await server.listen(); });
test.afterAll(async () => { await server?.close(); });
const open = async (page: any, query = "") => { await page.goto(server.resolvedUrls!.local[0] + "e2e/fixtures/notification-readiness.html" + query); await page.waitForFunction(() => !!window.readinessFixture); const details = page.locator("details.notification-readiness"); if (await details.count()) { await expect(page.getByText("正在检查接收状态…", { exact: true })).toHaveCount(0); if (!await details.evaluate((e: HTMLDetailsElement) => e.open)) await details.locator("summary").click(); } };
const recheck = async (page: any) => { const details = page.locator("details.notification-readiness"); if (!await details.evaluate((e: HTMLDetailsElement) => e.open)) await details.locator("summary").click(); await page.getByRole("button", { name: "检查接收状态", exact: true }).click(); };
test("Android silent notifications show channel alerts and open settings without altering consent", async ({ page }, info) => {
 await page.setViewportSize({ width: 390, height: 844 });
 await open(page, "?platform=android&permission=granted");
 await page.evaluate(() => { const n = window.readinessFixture.nativeState; n.soundEnabled = false; n.vibrationEnabled = false; });
 await recheck(page);
 await expect(page.getByText("接收条件已就绪", { exact: true })).toBeVisible();
 await expect(page.getByText("声音关闭 · 振动关闭", { exact: true })).toBeVisible();
 await openQuietHours(page); await page.getByLabel("勿扰开始", { exact: true }).fill("21:30");
 await page.getByRole("button", { name: "声音与振动设置", exact: true }).click();
 expect(await page.evaluate(() => window.readinessFixture.nativeState.calls.filter((s: string) => s === "settings"))).toHaveLength(1);
 expect(await page.evaluate(() => window.readinessFixture.fixture.writes)).toEqual([]);
 expect(await page.evaluate(() => window.readinessFixture.nativeState.calls)).not.toContain("TOKEN");
 await page.screenshot({ path: info.outputPath("android-channel-alerts.png"), fullPage: true });
 await page.evaluate(() => { const f = window.readinessFixture; f.nativeState.soundEnabled = true; f.nativeState.vibrationEnabled = true; f.foreground(); });
 await expect(page.getByText("声音开启 · 振动开启", { exact: true })).toBeVisible();
 await expect(page.getByLabel("勿扰开始", { exact: true })).toHaveValue("21:30");
 await page.evaluate(() => { window.readinessFixture.nativeState.settingsFail = true; });
 await page.getByRole("button", { name: "声音与振动设置", exact: true }).click();
 await expect(page.getByText("无法打开系统设置，请在手机设置中进入 TaroBird 的通知设置。", { exact: true })).toBeVisible();
});
for (const setting of ["sound", "vibration", "legacy", "missing"]) test(`Android channel alert status stays precise: ${setting}`, async ({ page }) => {
 await open(page, "?platform=android&permission=granted");
 await page.evaluate(setting => {
   const n = window.readinessFixture.nativeState;
   if (setting === "sound") n.soundEnabled = false;
   if (setting === "vibration") n.vibrationEnabled = false;
   if (setting === "legacy") { delete n.soundEnabled; delete n.vibrationEnabled; }
   if (setting === "missing") n.channel = "missing";
 }, setting);
 await recheck(page);
 if (setting === "sound" || setting === "vibration") await expect(page.getByText(setting === "sound" ? "声音关闭 · 振动开启" : "声音开启 · 振动关闭", { exact: true })).toBeVisible();
 else await expect(page.getByText(/声音(?:开启|关闭) · 振动(?:开启|关闭)/)).toHaveCount(0);
 await expect(page.getByRole("button", { name: "声音与振动设置", exact: true })).toBeVisible();
 expect(await page.evaluate(() => window.readinessFixture.fixture.writes)).toEqual([]);
});
test("phone notification settings focus on replies and files without implying unconfigured delivery works", async ({ page }, info) => {
 await page.setViewportSize({ width: 390, height: 844 });
 await open(page, "?platform=android&permission=granted&configured=false&enabled=false");
 await expect(page.getByText("手机通知尚未接通", { exact: true })).toBeVisible();
 await expect(page.getByRole("group", { name: "提醒内容", exact: true })).toContainText("回复完成");
 await expect(page.getByRole("group", { name: "提醒内容", exact: true })).toContainText("收到文件");
 await expect(page.getByText("UnifiedPush（无谷歌服务时使用）", { exact: true })).toBeHidden();
 await expect(page.getByText("接收条件已就绪", { exact: true })).toHaveCount(0);
 await expect(page.getByRole("switch", { name: "消息提醒", exact: true })).toBeDisabled();
 await page.screenshot({ path: info.outputPath("phone-message-notifications.png"), fullPage: true });
 await page.getByText("通知连接选项", { exact: true }).click();
 await expect(page.getByText("UnifiedPush（无谷歌服务时使用）", { exact: true })).toBeVisible();
 expect(await page.evaluate(() => window.readinessFixture.fixture.writes)).toEqual([]);
 expect(await page.evaluate(() => window.readinessFixture.nativeState.calls)).not.toContain("TOKEN");
});
test("denied system permission is visible while intent stays on; rechecking is read only and preserves draft", async ({ page }) => {
 await page.setViewportSize({ width: 390, height: 844 }); await open(page);
 await expect(page.getByText("系统通知已关闭", { exact: true })).toBeVisible();
 await expect(page.getByRole("switch", { name: "消息提醒", exact: true })).toHaveAttribute("aria-checked", "true");
 await openQuietHours(page); await page.getByLabel("勿扰开始", { exact: true }).fill("21:00");
 await recheck(page); await expect(page.getByText("系统通知已关闭", { exact: true })).toBeVisible();
 expect(await page.evaluate(() => window.readinessFixture.nativeState.calls.every((s: string) => s === "check"))).toBe(true);
 expect(await page.evaluate(() => window.readinessFixture.fixture.writes)).toEqual([]);
 await expect(page.getByLabel("勿扰开始", { exact: true })).toHaveValue("21:00");
 await page.evaluate(() => { window.readinessFixture.nativeState.permission = "granted"; window.readinessFixture.foreground(); });
 await expect(page.getByText("接收条件已就绪", { exact: true })).toBeVisible();
});
for (const kind of ["app", "channel", "missing", "old"]) test(`Android actual notification availability: ${kind}`, async ({ page }) => {
 await open(page, "?platform=android&permission=granted"); await expect(page.getByText("接收条件已就绪", { exact: true })).toBeVisible();
 await page.evaluate(kind => { const n = window.readinessFixture.nativeState; if (kind === "app") n.appEnabled = false; if (kind === "channel") n.channel = "disabled"; if (kind === "missing") n.channel = "missing"; if (kind === "old") n.old = true; }, kind);
 await recheck(page); await expect(page.getByText({ app: "系统通知已关闭", channel: "消息通知类别已关闭", missing: "等待首次消息提醒", old: "暂时无法检查接收状态" }[kind]!, { exact: true })).toBeVisible();
 expect(await page.evaluate(() => window.readinessFixture.fixture.writes)).toEqual([]);
});
for (const mode of ["legacy", "failure", "unconfigured", "settings-failure"]) test(`unknown and missing host configuration are never ready: ${mode}`, async ({ page }) => {
 await open(page, "?permission=granted"); await expect(page.getByText("接收条件已就绪", { exact: true })).toBeVisible();
 await page.evaluate(mode => { const f = window.readinessFixture; if (mode === "legacy") delete f.fixture.binding.subscribed; if (mode === "failure") f.fixture.fail = true; if (mode === "settings-failure") f.fixture.failSettings = true; if (mode === "unconfigured") f.connection.state.notifications.providers.apns = false; }, mode);
 await recheck(page); await expect(page.getByText(mode === "unconfigured" ? "主机推送尚未配置" : "暂时无法检查接收状态", { exact: true })).toBeVisible();
});
test("failed subscription repairs only the selected system provider with CAS and keeps quiet draft", async ({ page }) => {
 await open(page, "?platform=android&permission=granted&subscribed=false");
 await expect(page.getByText("推送连接需要恢复", { exact: true })).toBeVisible();
 await openQuietHours(page); await page.getByLabel("勿扰开始", { exact: true }).fill("20:00");
 await page.getByRole("button", { name: "重新连接推送", exact: true }).click();
 await expect(page.getByText("接收条件已就绪", { exact: true })).toBeVisible();
 expect(await page.evaluate(() => window.readinessFixture.fixture.writes)).toEqual([{ route: "/api/push", method: "PATCH", body: { provider: "fcm", token: "a".repeat(64), expectedRevision: "fixture-1" } }]);
 await expect(page.getByLabel("勿扰开始", { exact: true })).toHaveValue("20:00");
});
test("switching provider while recovery waits cannot be overwritten", async ({ page }) => {
 await open(page, "?platform=android&permission=granted&subscribed=false"); await expect(page.getByText("推送连接需要恢复", { exact: true })).toBeVisible();
 await page.evaluate(() => { window.readinessFixture.nativeState.holdToken = true; });
 await page.getByRole("button", { name: "重新连接推送", exact: true }).click();
 await expect.poll(() => page.evaluate(() => window.readinessFixture.nativeState.releases.length)).toBe(1);
 await page.evaluate(() => { const f = window.readinessFixture; f.fixture.binding = { ...f.fixture.binding, provider: "unifiedpush", revision: "changed" }; f.nativeState.releases.shift()(); });
 await expect(page.getByRole("alert").filter({ hasText: "恢复未完成" })).toBeVisible();
 expect(await page.evaluate(() => window.readinessFixture.fixture.binding.provider)).toBe("unifiedpush");
 expect(await page.evaluate(() => window.readinessFixture.fixture.writes.every((w: any) => w.method === "PATCH"))).toBe(true);
 await expect(page.getByRole("button", { name: "重新连接推送", exact: true })).toHaveCount(0);
});
test("UP invalid local registration directs the user to the distributor without FCM recovery", async ({ page }) => {
 await open(page, "?platform=android&permission=granted"); await expect(page.getByText("接收条件已就绪", { exact: true })).toBeVisible();
 await page.evaluate(() => { window.readinessFixture.fixture.binding.provider = "unifiedpush"; }); await recheck(page);
 await expect(page.getByText("分发器连接需要恢复", { exact: true })).toBeVisible();
 await expect(page.getByRole("button", { name: "重新连接推送", exact: true })).toHaveCount(0);
 expect(await page.evaluate(() => window.readinessFixture.nativeState.calls)).not.toContain("MIGRATE");
});
test("old pending read cannot replace a newer offline/foreground result", async ({ page }) => {
 await open(page, "?permission=granted"); await expect(page.getByText("接收条件已就绪", { exact: true })).toBeVisible();
 await page.evaluate(() => { window.readinessFixture.fixture.hold = true; }); await recheck(page);
 await expect.poll(() => page.evaluate(() => window.readinessFixture.fixture.releases.length)).toBeGreaterThan(0);
 await page.evaluate(() => { const f = window.readinessFixture; f.connection.state.status = "offline"; f.publish(); });
 await expect(page.getByText("连接主机后检查接收状态", { exact: true })).toBeVisible();
 await page.evaluate(() => { const f = window.readinessFixture; f.nativeState.permission = "denied"; f.fixture.hold = false; f.connection.state.status = "online"; f.publish(); });
 await expect(page.getByText("系统通知已关闭", { exact: true })).toBeVisible();
 await page.evaluate(() => window.readinessFixture.fixture.releases.splice(0).forEach((r: any) => r()));
 await expect(page.getByText("系统通知已关闭", { exact: true })).toBeVisible();
});
test("same-value preference reads do not retrigger installed token maintenance", async ({ page }) => {
 await open(page); await expect(page.getByText("系统通知已关闭", { exact: true })).toBeVisible();
 await page.evaluate(() => window.readinessFixture.startMaintenance());
 await expect.poll(() => page.evaluate(() => window.readinessFixture.nativeState.calls.filter((c: string) => c === "MAINTENANCE TOKEN").length)).toBe(1);
 await recheck(page); await expect(page.getByText("系统通知已关闭", { exact: true })).toBeVisible(); await recheck(page);
 await expect(page.getByText("系统通知已关闭", { exact: true })).toBeVisible();
 expect(await page.evaluate(() => window.readinessFixture.nativeState.calls.filter((c: string) => c === "MAINTENANCE TOKEN").length)).toBe(1);
});
test("language changes translate current status without rechecking; narrow screens do not overflow", async ({ page }) => {
 await page.setViewportSize({ width: 320, height: 740 }); await open(page);
 await expect(page.getByText("系统通知已关闭", { exact: true })).toBeVisible(); await page.evaluate(() => window.readinessFixture.setLocale("en"));
 await expect(page.getByText("System notifications are off", { exact: true })).toBeVisible();
 expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
 expect(await page.getByRole("button", { name: "Check receiving status", exact: true }).evaluate(el => el.getBoundingClientRect().height)).toBeGreaterThanOrEqual(44);
});

test("an older distributor read cannot roll back a completed connection", async ({ page }) => {
 await open(page, "?platform=android&permission=granted"); await expect(page.getByText("接收条件已就绪", { exact: true })).toBeVisible();
 await page.getByText("通知连接选项", { exact: true }).click();
 await page.evaluate(() => { window.readinessFixture.fixture.holdLocal = true; }); await page.getByRole("button", { name: "刷新", exact: true }).click();
 await expect.poll(() => page.evaluate(() => window.readinessFixture.fixture.localReleases.length)).toBe(1);
 await page.getByRole("button", { name: "连接分发器", exact: true }).click();
 await expect(page.getByText("此主机已注册到分发器「ntfy」。", { exact: true })).toBeVisible();
 await page.evaluate(() => window.readinessFixture.fixture.localReleases.shift()());
 await expect(page.getByText("此主机已注册到分发器「ntfy」。", { exact: true })).toBeVisible();
});
test("iOS maintenance winning the CAS clears a stale recovery error after rechecking", async ({ page }) => {
 await open(page, "?permission=granted&subscribed=false"); await expect(page.getByText("推送连接需要恢复", { exact: true })).toBeVisible();
 // Let real maintenance reach its first PATCH and hold it. Manual recovery
 // races under that same revision using the real native token reader.
 await page.evaluate(() => { const f = window.readinessFixture; f.fixture.holdPatch = true; f.startNativeMaintenance(); });
 await expect.poll(() => page.evaluate(() => window.readinessFixture.fixture.patchReleases.length)).toBe(1);
 // Hold the manual PATCH too so the earlier maintenance receipt can win.
 await page.evaluate(() => { window.readinessFixture.fixture.holdPatch = true; });
 await page.getByRole("button", { name: "重新连接推送", exact: true }).click();
 await expect.poll(() => page.evaluate(() => window.readinessFixture.fixture.patchReleases.length)).toBe(2);
 await page.evaluate(() => window.readinessFixture.fixture.patchReleases.shift()());
 await expect.poll(() => page.evaluate(() => window.readinessFixture.fixture.binding.subscribed)).toBe(true);
 await page.evaluate(() => window.readinessFixture.fixture.patchReleases.shift()());
 await expect(page.getByText("接收条件已就绪", { exact: true })).toBeVisible();
 await expect(page.getByRole("alert").filter({ hasText: "恢复未完成" })).toHaveCount(0);
 expect(await page.evaluate(() => window.readinessFixture.fixture.writes.every((w: any) => w.method === "PATCH"))).toBe(true);
});
test("leaving settings while token recovery waits prevents its late write", async ({ page }) => {
 await open(page, "?platform=android&permission=granted&subscribed=false"); await expect(page.getByText("推送连接需要恢复", { exact: true })).toBeVisible();
 await page.evaluate(() => { window.readinessFixture.nativeState.holdToken = true; }); await page.getByRole("button", { name: "重新连接推送", exact: true }).click();
 await expect.poll(() => page.evaluate(() => window.readinessFixture.nativeState.releases.length)).toBe(1);
 await page.evaluate(() => { const f = window.readinessFixture; f.unmount(); f.nativeState.releases.shift()(); });
 await expect.poll(() => page.evaluate(() => window.readinessFixture.nativeState.releases.length)).toBe(0);
 expect(await page.evaluate(() => window.readinessFixture.fixture.writes)).toEqual([]);
});
for (const [topics, detail] of [["none", "请先更新主机"], ["com.tarocub.client", "允许此 App 的标识"]] as const) test(`iOS readiness is not ready when the Host cannot route this App's APNs topic (${topics})`, async ({ page }) => {
 await open(page, `?permission=granted&apnsTopics=${topics}`);
 await expect(page.getByText("主机无法向此 App 推送", { exact: true })).toBeVisible();
 await expect(page.getByText(detail, { exact: false })).toBeVisible();
 await expect(page.getByText("接收条件已就绪", { exact: true })).toHaveCount(0);
 await expect(page.getByRole("button", { name: "重新连接推送", exact: true })).toHaveCount(0);
 expect(await page.evaluate(() => window.readinessFixture.fixture.writes)).toEqual([]);
});
