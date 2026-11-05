import { openQuietHours } from "./fixtures/settings.js";
import { test, expect, type Page } from "@playwright/test";
import { fileURLToPath } from "node:url";
import type { ViteDevServer } from "vite";
import { createServer } from "./fixtures/vite.js";
type Fixture = {
  start(): void; stop(): void; mountHost(ready?: boolean, failed?: boolean): Promise<void>; ready(): void; finishPairing(): void;
  activate(host?: string, message?: string, conversation?: string): void; silentNewClick(): void; emit(): void; deepLink(url?: string): void; accept(value: boolean): void;
  hold(command: string): void; fail(command: string, count: number): void; release(command: string): void;
  permissions(permission: string, request: string): void; enable(): Promise<void>; notify(host?: string): Promise<void>; clear(): Promise<void>; clearAll(): Promise<void>;
  setNoticePreferences(value: { enabled?: boolean; showPreview?: boolean; replyCompleted?: boolean }): void; notifyCurrent(): Promise<void>;
  permissionError(error: string, locale: "zh" | "en"): void;
  requestPermissionError(error: string): void; mountSettings(locale: "zh" | "en"): void;
  snapshot(): { targets: { hostId: string; messageId: string }[]; commands: { hostId: string; messageId: string }[]; errors: string[]; calls: { command: string; args?: any }[]; pending: any; result: string; lastError: string; observers: number };
};
declare global { interface Window { desktopNotificationFixture: Fixture } }
let server: ViteDevServer;
test.beforeAll(async () => {
  const replacement = fileURLToPath(new URL("./fixtures/desktop-notifications-bridge.ts", import.meta.url));
  server = await createServer({ resolve: { alias: [ { find: /^@tauri-apps\/(?:api\/(?:core|event)|plugin-(?:notification|deep-link))$/, replacement } ] }, server: { host: "127.0.0.1", port: 0, strictPort: false } }); await server.listen();
});
test.afterAll(async () => { await server?.close(); });
test.beforeEach(async ({ page }) => { await page.goto(server.resolvedUrls!.local[0] + "e2e/fixtures/desktop-notifications.html"); await page.waitForFunction(() => !!window.desktopNotificationFixture); });
const snapshot = (page: Page) => page.evaluate(() => window.desktopNotificationFixture.snapshot());
const peeks = async (page: Page) => (await snapshot(page)).calls.filter((c) => c.command === "desktop_notification_peek").length;
test.afterEach(async ({ page }) => { await page.evaluate(() => window.desktopNotificationFixture.stop()); expect((await snapshot(page)).errors).toEqual([]); });
test("a cold-start click is retained until the frontend listens and accepts it", async ({ page }) => {
  await page.evaluate(() => { const f = window.desktopNotificationFixture; f.activate("a", "first"); f.start(); });
  await expect.poll(async () => (await snapshot(page)).targets.map((t) => t.messageId)).toEqual(["first"]);
  await expect.poll(async () => (await snapshot(page)).pending).toBeNull();
  const calls = (await snapshot(page)).calls.map((c) => c.command);
  expect(calls.indexOf("listen tarocub-notification-action")).toBeLessThan(calls.indexOf("desktop_notification_peek"));
});
test("Windows notification protocol forwarded by deep-link cannot duplicate or supersede the native inbox", async ({ page }) => {
  await page.evaluate(() => { const f = window.desktopNotificationFixture; f.activate(); f.start(); });
  await expect.poll(async () => (await snapshot(page)).targets).toHaveLength(1);
  await page.evaluate(() => {
    const f = window.desktopNotificationFixture;
    f.deepLink(`tarocub://notification/chat?message=message&host=hub_${"a".repeat(64)}`);
    f.emit();
  });
  expect((await snapshot(page)).targets).toHaveLength(1);
  await expect.poll(async () => (await snapshot(page)).pending).toBeNull();
});
test("host removal cancels a pre-submission wait while preserving a new notification after cleanup", async ({ page }) => {
  await page.evaluate(() => { const f = window.desktopNotificationFixture; f.hold("desktop_notifications_supported"); void f.notify(); });
  await expect.poll(async () => (await snapshot(page)).calls.some((c) => c.command === "desktop_notifications_supported")).toBe(true);
  await page.evaluate(() => { const f = window.desktopNotificationFixture; void f.clear(); f.release("desktop_notifications_supported"); });
  await expect.poll(async () => (await snapshot(page)).calls.some((c) => c.command === "desktop_notification_clear")).toBe(true);
  expect((await snapshot(page)).calls.filter((c) => c.command === "desktop_notification_show")).toEqual([]);
  await page.evaluate(() => window.desktopNotificationFixture.notify());
  expect((await snapshot(page)).calls.filter((c) => c.command === "desktop_notification_show")).toHaveLength(1);
});
test("removing one host does not cancel another host's pending notification", async ({ page }) => {
  await page.evaluate(() => { const f = window.desktopNotificationFixture; f.hold("desktop_notifications_supported"); void f.notify("b"); void f.clear(); f.release("desktop_notifications_supported"); });
  await expect.poll(async () => (await snapshot(page)).result).toBe("sent");
  expect((await snapshot(page)).calls.find((c) => c.command === "desktop_notification_show")!.args.notice.hostId).toBe(`hub_${"b".repeat(64)}`);
});
test("host cleanup waits for an already submitted show RPC before clearing native history", async ({ page }) => {
  await page.evaluate(() => { const f = window.desktopNotificationFixture; f.hold("desktop_notification_show"); void f.notify(); });
  await expect.poll(async () => (await snapshot(page)).calls.some((c) => c.command === "desktop_notification_show")).toBe(true);
  await page.evaluate(() => { void window.desktopNotificationFixture.clear(); });
  await page.waitForTimeout(50);
  expect((await snapshot(page)).calls.filter((c) => c.command === "desktop_notification_clear")).toEqual([]);
  await page.evaluate(() => window.desktopNotificationFixture.release("desktop_notification_show"));
  await expect.poll(async () => (await snapshot(page)).calls.some((c) => c.command === "desktop_notification_clear")).toBe(true);
});
test("a slow native submission on another host does not block host cleanup", async ({ page }) => {
  await page.evaluate(() => { const f = window.desktopNotificationFixture; f.hold("desktop_notification_show"); void f.notify("b"); });
  await expect.poll(async () => (await snapshot(page)).calls.some((c) => c.command === "desktop_notification_show")).toBe(true);
  await page.evaluate(() => window.desktopNotificationFixture.clear());
  expect((await snapshot(page)).calls.filter((c) => c.command === "desktop_notification_clear")).toHaveLength(1);
  await page.evaluate(() => window.desktopNotificationFixture.release("desktop_notification_show"));
});
test("global cleanup drains both hosts and a later reminder waits until cleanup completes", async ({ page }) => {
  await page.evaluate(() => { const f = window.desktopNotificationFixture; f.hold("desktop_notification_show"); f.hold("desktop_notification_clear"); void f.notify(); void f.notify("b"); });
  await expect.poll(async () => (await snapshot(page)).calls.filter((c) => c.command === "desktop_notification_show")).toHaveLength(2);
  await page.evaluate(() => { void window.desktopNotificationFixture.clearAll(); });
  await page.waitForTimeout(50);
  expect((await snapshot(page)).calls.filter((c) => c.command === "desktop_notification_clear")).toEqual([]);
  await page.evaluate(() => window.desktopNotificationFixture.release("desktop_notification_show"));
  await expect.poll(async () => (await snapshot(page)).calls.filter((c) => c.command === "desktop_notification_clear")).toHaveLength(1);
  expect((await snapshot(page)).calls.find((c) => c.command === "desktop_notification_clear")!.args).toEqual({ documentId: "fixture-document" });
  await page.evaluate(() => { void window.desktopNotificationFixture.notify("b"); });
  await page.waitForTimeout(50);
  expect((await snapshot(page)).calls.filter((c) => c.command === "desktop_notification_show")).toHaveLength(2);
  await page.evaluate(() => window.desktopNotificationFixture.release("desktop_notification_clear"));
  await expect.poll(async () => (await snapshot(page)).calls.filter((c) => c.command === "desktop_notification_show")).toHaveLength(3);
});
for (const locale of ["zh", "en"] as const) test(`missing Windows installation reports actionable ${locale} guidance and does not enable Hub notifications`, async ({ page }) => {
  await page.evaluate((locale) => { const f = window.desktopNotificationFixture; f.permissionError("native_notification_install_required", locale); return f.enable(); }, locale);
  const result = await snapshot(page);
  expect(result.result).toBe("failed");
  expect(result.lastError).toContain(locale === "zh" ? "开始菜单快捷方式" : "Start Menu shortcut");
  expect(result.lastError).not.toContain("native_notification");
  expect(result.calls.filter((c) => c.command.startsWith("http "))).toEqual([]);
});
for (const locale of ["zh", "en"] as const) for (const request of [false, true]) test(`native permission ${request ? "request" : "read"} timeout unlocks settings and a granted retry preserves preferences (${locale})`, async ({ page }) => {
  const zh = locale === "zh";
  await page.evaluate(({ locale, request }) => {
    const f = window.desktopNotificationFixture; f.mountSettings(locale); f.permissions(request ? "prompt" : "granted", "granted");
    if (request) f.requestPermissionError("native_notification_timeout"); else f.permissionError("native_notification_timeout", locale);
    f.hold("desktop_notification_permission");
  }, { locale, request });
  const enable = () => page.getByRole("switch", { name: zh ? "消息提醒" : "Message alerts", exact: true });
  const quietStart = page.getByLabel(zh ? "勿扰开始" : "Quiet hours start", { exact: true });
  const quietEnd = page.getByLabel(zh ? "勿扰结束" : "Quiet hours end", { exact: true });
  await openQuietHours(page);
  await expect(enable()).toHaveAttribute("aria-checked", "false");
  await enable().click();
  await expect.poll(async () => (await snapshot(page)).calls.filter(c => c.command === "desktop_notification_permission")).toHaveLength(1);
  await expect(enable()).toBeDisabled();
  await expect(page.locator("#notification-master-detail")).toHaveText(zh ? "正在保存…" : "Saving…");
  await expect(quietStart).toBeDisabled();
  await page.evaluate(() => window.desktopNotificationFixture.release("desktop_notification_permission"));
  await expect(page.getByRole("alert")).toHaveText(request
    ? zh ? "系统通知授权尚未完成，请检查系统通知设置。" : "Notification permission is not complete. Check the system notification settings."
    : zh ? "无法读取系统通知权限，请检查系统设置后重试。" : "Unable to read notification permission. Check system settings, then try again.");
  await expect(enable()).toBeEnabled(); await expect(enable()).toHaveAttribute("aria-checked", "false"); await expect(quietStart).toBeEnabled();
  await expect(quietStart).toHaveValue("22:00"); await expect(quietEnd).toHaveValue("07:00");
  expect((await snapshot(page)).calls.filter(c => c.command.startsWith("http "))).toEqual([]);
  expect((await snapshot(page)).calls.filter(c => c.command === "desktop_notification_permission").map(c => c.args.request)).toEqual(request ? [false, true] : [false]);
  await page.evaluate(locale => { const f = window.desktopNotificationFixture; f.permissionError("", locale); f.requestPermissionError(""); f.permissions("granted", "denied"); }, locale);
  await enable().click();
  await expect(enable()).toHaveAttribute("aria-checked", "true"); await expect(enable()).toBeEnabled();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(quietStart).toHaveValue("22:00"); await expect(quietEnd).toHaveValue("07:00");
  const calls = (await snapshot(page)).calls;
  expect(calls.filter(c => c.command.startsWith("http "))).toEqual([{ command: "http /api/notifications", args: { method: "PUT", body: { enabled: true, quietStart: "22:00", quietEnd: "07:00", timeZone: "Asia/Shanghai" } } }]);
  expect(calls.filter(c => c.command === "desktop_notification_permission" && c.args.request)).toHaveLength(request ? 1 : 0);
});
for (const locale of ["zh", "en"] as const) test(`native permission request failure is distinct from a settings read failure (${locale})`, async ({ page }) => {
  await page.evaluate(locale => { const f = window.desktopNotificationFixture; f.permissionError("", locale); f.permissions("prompt", "granted"); f.requestPermissionError("native_notification_permission_failed"); return f.enable(); }, locale);
  const result = await snapshot(page);
  expect(result.lastError).toBe(locale === "zh" ? "无法完成系统通知授权，请检查系统通知设置。" : "Unable to complete notification permission. Check the system notification settings.");
  expect(result.calls.filter(c => c.command.startsWith("http "))).toEqual([]);
});
test("a newer click overtakes a captured but delayed peek without routing the old target", async ({ page }) => {
  await page.evaluate(() => { const f = window.desktopNotificationFixture; f.hold("desktop_notification_peek"); f.activate("a", "old"); f.start(); });
  await expect.poll(() => peeks(page)).toBe(1);
  await page.evaluate(() => { const f = window.desktopNotificationFixture; f.activate("b", "new"); f.release("desktop_notification_peek"); });
  await expect.poll(async () => (await snapshot(page)).targets.map((t) => t.messageId)).toEqual(["new"]);
  expect((await snapshot(page)).targets[0]!.hostId).toBe(`hub_${"b".repeat(64)}`);
});
test("disposed peek cannot route or acknowledge, and its replacement can recover", async ({ page }) => {
  await page.evaluate(() => { const f = window.desktopNotificationFixture; f.hold("desktop_notification_peek"); f.activate(); f.start(); });
  await expect.poll(() => peeks(page)).toBe(1);
  await page.evaluate(() => { const f = window.desktopNotificationFixture; f.stop(); f.release("desktop_notification_peek"); });
  await page.waitForTimeout(30); expect((await snapshot(page)).targets).toEqual([]); expect((await snapshot(page)).pending).not.toBeNull();
  await page.evaluate(() => window.desktopNotificationFixture.start());
  await expect.poll(async () => (await snapshot(page)).targets).toHaveLength(1);
  await expect.poll(async () => (await snapshot(page)).pending).toBeNull();
});
test("a newer ordinary deep link supersedes an older held notification read", async ({ page }) => {
  await page.evaluate(() => { const f = window.desktopNotificationFixture; f.hold("desktop_notification_peek"); f.activate("a", "old"); f.start(); });
  await expect.poll(() => peeks(page)).toBe(1);
  await page.evaluate(() => { const f = window.desktopNotificationFixture; f.deepLink(); f.release("desktop_notification_peek"); });
  await expect.poll(async () => (await snapshot(page)).pending).toBeNull();
  expect((await snapshot(page)).targets.map((t) => t.messageId)).toEqual(["external"]);
});
for (const command of ["desktop_notifications_supported", "listen tarocub-notification-action"]) test(`newer navigation also wins during held setup: ${command}`, async ({ page }) => {
  await page.evaluate((command) => { const f = window.desktopNotificationFixture; f.hold(command); f.activate("a", "old"); f.start(); }, command);
  await expect.poll(async () => (await snapshot(page)).calls.some((c) => c.command === command)).toBe(true);
  await page.evaluate((command) => { const f = window.desktopNotificationFixture; f.deepLink(); f.release(command); }, command);
  await expect.poll(async () => (await snapshot(page)).pending).toBeNull();
  expect((await snapshot(page)).targets.map((t) => t.messageId)).toEqual(["external"]);
});
test("a newer OS click during setup survives earlier navigation", async ({ page }) => {
  await page.evaluate(() => { const f = window.desktopNotificationFixture; f.hold("desktop_notifications_supported"); f.activate("a", "old"); f.start(); });
  await page.evaluate(() => window.desktopNotificationFixture.deepLink());
  await page.evaluate(() => { const f = window.desktopNotificationFixture; f.activate("b", "new"); f.release("desktop_notifications_supported"); });
  await expect.poll(async () => (await snapshot(page)).targets.map((t) => t.messageId)).toEqual(["external", "new"]);
});
test("a new click visible to peek before its wakeup is not swallowed", async ({ page }) => {
  await page.evaluate(() => { const f = window.desktopNotificationFixture; f.accept(false); f.activate("a", "old"); f.start(); });
  await expect.poll(async () => (await snapshot(page)).targets).toHaveLength(1);
  await page.evaluate(() => window.desktopNotificationFixture.hold("desktop_notification_peek"));
  await page.locator("#manual").click();
  await page.evaluate(() => { const f = window.desktopNotificationFixture; f.accept(true); f.silentNewClick(); f.release("desktop_notification_peek"); });
  await expect.poll(async () => (await snapshot(page)).targets.map((t) => t.messageId)).toEqual(["old", "new"]);
  await page.evaluate(() => window.desktopNotificationFixture.emit());
  expect((await snapshot(page)).targets.map((t) => t.messageId)).toEqual(["old", "new"]);
});
test("ACK failure and duplicate wakeups do not repeat the same navigation", async ({ page }) => {
  await page.evaluate(() => { const f = window.desktopNotificationFixture; f.fail("desktop_notification_ack", 1); f.activate(); f.start(); });
  await expect.poll(async () => (await snapshot(page)).targets).toHaveLength(1);
  await page.evaluate(() => { const f = window.desktopNotificationFixture; f.emit(); f.emit(); });
  await expect.poll(async () => (await snapshot(page)).pending).toBeNull(); expect((await snapshot(page)).targets).toHaveLength(1);
});
test("an unaccepted route remains pending and retries only when its receiver is ready", async ({ page }) => {
  await page.evaluate(() => { const f = window.desktopNotificationFixture; f.accept(false); f.activate(); f.start(); });
  await expect.poll(async () => (await snapshot(page)).targets).toHaveLength(1); expect((await snapshot(page)).pending).not.toBeNull();
  await page.evaluate(() => { const f = window.desktopNotificationFixture; f.accept(true); f.ready(); });
  await expect.poll(async () => (await snapshot(page)).pending).toBeNull(); expect((await snapshot(page)).targets).toHaveLength(2);
});
test("manual input supersedes a deferred click, while a later OS click still works", async ({ page }) => {
  await page.evaluate(() => { const f = window.desktopNotificationFixture; f.accept(false); f.activate("a", "old"); f.start(); });
  await expect.poll(async () => (await snapshot(page)).targets).toHaveLength(1);
  await page.locator("#manual").click();
  await expect.poll(async () => (await snapshot(page)).pending).toBeNull();
  await page.evaluate(() => { const f = window.desktopNotificationFixture; f.accept(true); f.ready(); f.activate("b", "new"); });
  await expect.poll(async () => (await snapshot(page)).targets.map((t) => t.messageId)).toEqual(["old", "new"]);
});
test("peek failures recover with a bounded retry instead of losing the retained click", async ({ page }) => {
  await page.evaluate(() => { const f = window.desktopNotificationFixture; f.fail("desktop_notification_peek", 1); f.activate(); f.start(); });
  await expect.poll(async () => (await snapshot(page)).targets, { timeout: 5000 }).toHaveLength(1); expect(await peeks(page)).toBe(2);
});
test("permanent IPC failure stops after eight reads and disposal stops recovery", async ({ page }) => {
  await page.clock.install(); await page.clock.pauseAt(new Date());
  await page.evaluate(() => { const f = window.desktopNotificationFixture; f.fail("desktop_notification_peek", 100); f.start(); });
  await expect.poll(() => peeks(page)).toBe(1);
  for (const [index, delay] of [1_000, 2_000, 5_000, 15_000, 30_000, 30_000, 30_000].entries()) {
    await page.clock.runFor(delay); await expect.poll(() => peeks(page)).toBe(index + 2);
  }
  await page.clock.runFor(3_600_000); expect(await peeks(page)).toBe(8);
  await page.evaluate(() => window.desktopNotificationFixture.stop());
  await page.clock.runFor(3_600_000); expect(await peeks(page)).toBe(8);
});
test("a held old ACK cannot block or consume a newer click", async ({ page }) => {
  await page.evaluate(() => { const f = window.desktopNotificationFixture; f.hold("desktop_notification_ack"); f.activate("a", "old"); f.start(); });
  await expect.poll(async () => (await snapshot(page)).targets).toHaveLength(1);
  await page.evaluate(() => window.desktopNotificationFixture.activate("b", "new"));
  await expect.poll(async () => (await snapshot(page)).targets.map((t) => t.messageId)).toEqual(["old", "new"]);
  await page.evaluate(() => window.desktopNotificationFixture.release("desktop_notification_ack"));
  await expect.poll(async () => (await snapshot(page)).pending).toBeNull();
});
test("real HostApp accepts distinct hosts with the same conversation and message IDs", async ({ page }) => {
  await page.evaluate(() => window.desktopNotificationFixture.mountHost());
  await expect(page.getByRole("button", { name: "添加主机", exact: true })).toBeVisible();
  await expect.poll(() => peeks(page)).toBeGreaterThan(0);
  for (const host of ["a", "b"]) {
    await page.evaluate((host) => window.desktopNotificationFixture.activate(host), host);
    await expect.poll(async () => (await snapshot(page)).commands.at(-1)?.hostId).toBe(`hub_${host.repeat(64)}`);
    await expect.poll(async () => (await snapshot(page)).pending).toBeNull();
  }
  expect((await snapshot(page)).commands.map((c) => c.messageId)).toEqual(["message", "message"]);
});
test("real HostApp defers a temporarily unavailable host and consumes after it becomes ready", async ({ page }) => {
  await page.evaluate(() => { const f = window.desktopNotificationFixture; f.activate(); return f.mountHost(false); });
  await expect.poll(() => peeks(page)).toBeGreaterThan(0);
  await expect(page.getByRole("alert")).toHaveCount(0);
  expect((await snapshot(page)).pending).not.toBeNull(); expect((await snapshot(page)).commands).toEqual([]);
  await page.evaluate(() => window.desktopNotificationFixture.ready());
  await expect.poll(async () => (await snapshot(page)).commands).toHaveLength(1);
  await expect.poll(async () => (await snapshot(page)).pending).toBeNull();
});
test("real HostApp reports a removed host and discards its click instead of opening another host", async ({ page }) => {
  await page.evaluate(() => { const f = window.desktopNotificationFixture; f.activate("c"); return f.mountHost(); });
  await expect(page.getByRole("alert")).toContainText("无法确定这条通知所属的主机");
  await expect.poll(async () => (await snapshot(page)).pending).toBeNull(); expect((await snapshot(page)).commands).toEqual([]);
});
test("native permission denial never enables Hub preferences or falls back to fake granted", async ({ page }) => {
  await page.evaluate(() => { const f = window.desktopNotificationFixture; f.permissions("prompt", "denied"); return f.enable(); });
  expect((await snapshot(page)).result).toBe("failed"); expect((await snapshot(page)).calls.filter((c) => c.command.startsWith("http "))).toEqual([]);
  await page.evaluate(() => { const f = window.desktopNotificationFixture; f.permissions("granted", "denied"); return f.enable(); });
  expect((await snapshot(page)).result).toBe("enabled");
  expect((await snapshot(page)).calls.filter((c) => c.command === "desktop_notification_permission" && c.args.request)).toHaveLength(1);
  expect((await snapshot(page)).calls.filter((c) => c.command.startsWith("http "))).toHaveLength(1);
});
test("native send preserves full destination, returns submission errors, and host cleanup is scoped", async ({ page }) => {
  await page.evaluate(() => window.desktopNotificationFixture.notify()); expect((await snapshot(page)).result).toBe("sent");
  const notice = (await snapshot(page)).calls.find((c) => c.command === "desktop_notification_show")!.args.notice;
  expect(notice).toMatchObject({ hostId: `hub_${"a".repeat(64)}`, conversationId: "chat", messageId: "message", id: "notice" });
  await page.evaluate(() => { const f = window.desktopNotificationFixture; f.fail("desktop_notification_show", 1); return f.notify(); }); expect((await snapshot(page)).result).toBe("failed");
  await page.evaluate(() => { const f = window.desktopNotificationFixture; f.activate("b"); return f.clear(); });
  expect((await snapshot(page)).pending.target.hostId).toBe(`hub_${"b".repeat(64)}`);
  expect((await snapshot(page)).calls.at(-1)).toEqual({ command: "desktop_notification_clear", args: { hostId: `hub_${"a".repeat(64)}`, documentId: "fixture-document" } });
});

for (const offset of [-3_600_000, 3_600_000]) test(`wall clock change ${offset} does not drop a new click during setup`, async ({ page }) => {
  await page.evaluate(() => { const f = window.desktopNotificationFixture; f.hold("desktop_notifications_supported"); f.activate("a", "old"); f.start(); f.deepLink(); });
  await page.evaluate((offset) => { const original = Date.now; Date.now = () => original() + offset; const f = window.desktopNotificationFixture; f.activate("b", "new"); f.release("desktop_notifications_supported"); }, offset);
  await expect.poll(async () => (await snapshot(page)).targets.map((t) => t.messageId)).toEqual(["external", "new"]);
});
test("disposing an unresolved native registration immediately removes DOM observers", async ({ page }) => {
  const before = (await snapshot(page)).observers;
  await page.evaluate(() => { const f = window.desktopNotificationFixture; f.hold("listen tarocub-notification-action"); f.start(); });
  await expect.poll(async () => (await snapshot(page)).calls.some((c) => c.command === "listen tarocub-notification-action")).toBe(true);
  expect((await snapshot(page)).observers).toBeGreaterThan(before);
  await page.evaluate(() => window.desktopNotificationFixture.stop());
  expect((await snapshot(page)).observers).toBe(before);
  await page.evaluate(() => { const f = window.desktopNotificationFixture; f.activate(); f.release("listen tarocub-notification-action"); });
  await expect.poll(async () => (await snapshot(page)).calls.some((c) => c.command === "unlisten tarocub-notification-action")).toBe(true);
  expect((await snapshot(page)).targets).toEqual([]); expect((await snapshot(page)).pending).not.toBeNull();
});
test("real HostApp preserves a click while pairing hides the destination", async ({ page }) => {
  await page.evaluate(() => window.desktopNotificationFixture.mountHost());
  await expect(page.getByRole("button", { name: "添加主机", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "添加主机", exact: true }).click();
  await expect(page.getByText("Pairing", { exact: true })).toBeVisible();
  await page.evaluate(() => window.desktopNotificationFixture.activate());
  await expect.poll(() => peeks(page)).toBeGreaterThan(1);
  expect((await snapshot(page)).pending).not.toBeNull(); expect((await snapshot(page)).commands).toEqual([]);
  await page.evaluate(() => window.desktopNotificationFixture.finishPairing());
  await expect.poll(async () => (await snapshot(page)).commands).toHaveLength(1);
  await expect.poll(async () => (await snapshot(page)).pending).toBeNull();
});
test("real HostApp reports a failed connection once and consumes its unusable click", async ({ page }) => {
  await page.evaluate(() => { const f = window.desktopNotificationFixture; f.activate(); return f.mountHost(false, true); });
  await expect(page.getByRole("alert")).toContainText("目标主机尚未连接");
  await expect.poll(async () => (await snapshot(page)).pending).toBeNull();
  expect((await snapshot(page)).commands).toEqual([]);
});

for (const gate of ["desktop_notifications_supported", "desktop_notification_context", "desktop_notification_show"]) {
  for (const change of ["hide", "disable", "filter"] as const) test(`current notification choice ${change} wins while ${gate} is pending`, async ({ page }) => {
    await page.evaluate(gate => {
      const f = window.desktopNotificationFixture; f.hold(gate);
      if (gate === "desktop_notification_show") void f.notify();
      else void f.notifyCurrent();
    }, gate);
    await expect.poll(async () => (await snapshot(page)).calls.some(call => call.command === gate)).toBe(true);
    if (gate === "desktop_notification_show") await page.evaluate(() => { void window.desktopNotificationFixture.notifyCurrent(); });
    await page.evaluate(({ gate, change }) => {
      const f = window.desktopNotificationFixture;
      f.setNoticePreferences(change === "hide" ? { showPreview: false } : change === "disable" ? { enabled: false } : { replyCompleted: false });
      f.release(gate);
    }, { gate, change });
    await expect.poll(async () => (await snapshot(page)).result).toBe("settled");
    const sent = (await snapshot(page)).calls.filter(call => call.command === "desktop_notification_show" && call.args.notice.id === "private-message");
    if (change === "hide") {
      expect(sent).toHaveLength(1);
      expect(sent[0]!.args.notice.body).toBe("A Bot finished replying. Tap to view.");
    } else expect(sent).toEqual([]);
  });
}
