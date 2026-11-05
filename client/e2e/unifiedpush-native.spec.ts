import { openQuietHours } from "./fixtures/settings.js";
import { test, expect } from "@playwright/test";
import type { ViteDevServer } from "vite";
import { createServer } from "./fixtures/vite.js";
import { generateKeyPairSync } from "node:crypto";
import { fileURLToPath } from "node:url";

type Fixture = { clear(): Promise<void>; firebase: { clearHold: boolean; releaseClear?: () => void; calls: string[]; hold: boolean; error: string; token: string; release(index: number, error?: string): void; emit(event: string, value: unknown): void }; setup(keys: string[]): void; render(index: number): void; renderMain(index: number): void; preferences(index: number): { quietStart: string }; migrateOffline(): Promise<{ migrateLegacy?: boolean }[]>; enable(index: number): Promise<void>; fcm(index: number): Promise<void>; resume(index: number): Promise<void>; remove(index: number): Promise<void>; maintain(): Promise<void>; rotate(index: number): void; controls(options: { nativeRead?: boolean; refresh?: boolean; cleanupBefore?: boolean; put?: boolean; delete?: boolean; cleanup?: boolean; holdPut?: boolean; holdPreferences?: boolean; oldNative?: boolean }): void; release(): void; snapshot(): { records: { instance: string; registrationId: string; phase: string; remoteRemoval?: boolean }[]; remote: (string | undefined)[]; log: string[] } };
declare global { interface Window { unifiedNativeFixture: Fixture; operationResult?: string } }
let server: ViteDevServer;
test.beforeAll(async () => { server = await createServer({ resolve: { alias: [
  { find: /^@capacitor\/core$/, replacement: fileURLToPath(new URL("./fixtures/unifiedpush-core.ts", import.meta.url)) },
  { find: /^@capacitor\/push-notifications$/, replacement: fileURLToPath(new URL("./fixtures/unifiedpush-notifications.ts", import.meta.url)) },
] }, server: { host: "127.0.0.1", port: 0, strictPort: false } }); await server.listen(); });
test.afterAll(async () => { await server?.close(); });
test.beforeEach(async ({ page }) => {
  await page.goto(server.resolvedUrls!.local[0] + "e2e/fixtures/unifiedpush-native.html");
  await page.waitForFunction(() => !!window.unifiedNativeFixture);
  const keys = Array.from({ length: 2 }, () => generateKeyPairSync("ed25519").publicKey.export({ format: "der", type: "spki" }).toString("base64"));
  await page.evaluate((keys) => window.unifiedNativeFixture.setup(keys), keys);
});
test("settings retries failed server deletion without disturbing the second host", async ({ page }) => {
  await page.evaluate(async () => { await window.unifiedNativeFixture.enable(0); await window.unifiedNativeFixture.enable(1); window.unifiedNativeFixture.controls({ delete: true }); window.unifiedNativeFixture.render(0); });
  await page.getByRole("button", { name: "断开分发器", exact: true }).click();
  await expect(page.getByRole("button", { name: "继续完成清理", exact: true })).toBeEnabled();
  let state = await page.evaluate(() => window.unifiedNativeFixture.snapshot());
  expect(state.records[0]!.phase).toBe("removing"); await expect(page.getByRole("button", { name: "连接分发器", exact: true })).toBeDisabled(); expect(state.remote).toEqual(["unifiedpush", "unifiedpush"]);
  await page.getByRole("button", { name: "继续完成清理", exact: true }).click();
  await expect(page.getByRole("button", { name: "继续完成清理", exact: true })).toHaveCount(0);
  state = await page.evaluate(() => window.unifiedNativeFixture.snapshot()); expect(state.records).toHaveLength(1); expect(state.records[0]!.phase).toBe("active"); expect(state.remote).toEqual([undefined,"unifiedpush"]);
});
test("settings prevents changing the distributor used by another host", async ({ page }) => {
  await page.evaluate(async () => { await window.unifiedNativeFixture.enable(0); window.unifiedNativeFixture.render(1); });
  await expect(page.getByRole("option", { name: "Distributor Two" })).toBeDisabled();
  await expect(page.getByText("每台主机独立注册与断开；分发器应用由所有主机共用。")).toBeVisible();
});
test("removal waits for a slow registration PUT and leaves no remote subscription", async ({ page }) => {
  await page.evaluate(() => { window.unifiedNativeFixture.controls({ holdPut: true }); void window.unifiedNativeFixture.enable(0).then(() => { window.operationResult = "registered"; }); });
  await expect.poll(() => page.evaluate(() => window.unifiedNativeFixture.snapshot().log)).toContain("0 PUT /api/push start");
  await page.evaluate(() => { void window.unifiedNativeFixture.remove(0).then(() => { window.operationResult = "removed"; }); });
  expect(await page.evaluate(() => window.unifiedNativeFixture.snapshot().log)).not.toContain("0 DELETE /api/push start");
  await page.evaluate(() => window.unifiedNativeFixture.release());
  await expect.poll(() => page.evaluate(() => window.operationResult)).toBe("removed");
  const state = await page.evaluate(() => window.unifiedNativeFixture.snapshot()); expect(state.remote).toEqual([undefined]); expect(state.records).toHaveLength(0);
  expect(state.log.indexOf("0 PUT /api/push done")).toBeLessThan(state.log.indexOf("0 DELETE /api/push start"));
});
test("endpoint refreshes reach all hosts and cannot revive a removed host", async ({ page }) => {
  await page.evaluate(async () => { await window.unifiedNativeFixture.enable(0); await window.unifiedNativeFixture.enable(1); await window.unifiedNativeFixture.maintain(); });
  await expect.poll(() => page.evaluate(() => window.unifiedNativeFixture.snapshot().log.filter((x) => x.endsWith("PUT /api/push done")).length)).toBe(4);
  await page.evaluate(() => { window.unifiedNativeFixture.rotate(0); window.unifiedNativeFixture.rotate(1); });
  await expect.poll(() => page.evaluate(() => window.unifiedNativeFixture.snapshot().log.filter((x) => x.endsWith("PUT /api/push done")).length)).toBe(6);
  await page.evaluate(async () => { window.unifiedNativeFixture.rotate(0); await window.unifiedNativeFixture.remove(0); });
  const state = await page.evaluate(() => window.unifiedNativeFixture.snapshot()); expect(state.remote).toEqual([undefined,"unifiedpush"]); expect(state.log.at(-1)).toBe("0 DELETE /api/push done");
});
test("retrying local cleanup after an FCM switch keeps the working FCM registration", async ({ page }) => {
  await page.evaluate(async () => { await window.unifiedNativeFixture.enable(0); window.unifiedNativeFixture.controls({ cleanup: true }); await window.unifiedNativeFixture.fcm(0).catch(() => undefined); window.unifiedNativeFixture.render(0); });
  const before = await page.evaluate(() => window.unifiedNativeFixture.snapshot()); expect(before.remote).toEqual(["fcm"]); expect(before.records[0]!.remoteRemoval).toBe(false);
  await page.getByRole("button", { name: "继续完成清理", exact: true }).click();
  await expect(page.getByRole("button", { name: "继续完成清理", exact: true })).toHaveCount(0);
  const after = await page.evaluate(() => window.unifiedNativeFixture.snapshot()); expect(after.remote).toEqual(["fcm"]); expect(after.records).toHaveLength(0); expect(after.log).not.toContain("0 DELETE /api/push start");
});

test("notification enable preferences settle before a queued disconnect", async ({ page }) => {
  await page.evaluate(() => { window.unifiedNativeFixture.controls({ holdPreferences: true }); void window.unifiedNativeFixture.fcm(0); });
  await expect.poll(() => page.evaluate(() => window.unifiedNativeFixture.snapshot().log)).toContain("0 PUT /api/notifications start");
  await page.evaluate(() => { void window.unifiedNativeFixture.remove(0).then(() => { window.operationResult = "removed"; }); });
  await page.waitForTimeout(50);
  expect(await page.evaluate(() => window.unifiedNativeFixture.snapshot().log)).not.toContain("0 DELETE /api/push start");
  await page.evaluate(() => window.unifiedNativeFixture.release());
  await expect.poll(() => page.evaluate(() => window.operationResult)).toBe("removed");
  const log = await page.evaluate(() => window.unifiedNativeFixture.snapshot().log);
  expect(log.indexOf("0 PUT /api/notifications done")).toBeLessThan(log.indexOf("0 DELETE /api/push start"));
});

test("FCM switch fences the old endpoint before its Hub write, including reconnects", async ({ page }) => {
  await page.evaluate(async () => { await window.unifiedNativeFixture.enable(0); window.unifiedNativeFixture.controls({ holdPut: true }); void window.unifiedNativeFixture.fcm(0).then(() => { window.operationResult = "switched"; }); });
  await expect.poll(() => page.evaluate(() => window.unifiedNativeFixture.snapshot().log.filter((x) => x === "0 PUT /api/push start").length)).toBe(2);
  let state = await page.evaluate(() => window.unifiedNativeFixture.snapshot()); expect(state.records[0]!.phase).toBe("removing"); expect(state.records[0]!.remoteRemoval).toBe(false);
  await page.evaluate(() => { void window.unifiedNativeFixture.maintain(); });
  await page.evaluate(() => window.unifiedNativeFixture.release());
  await expect.poll(() => page.evaluate(() => window.operationResult)).toBe("switched");
  state = await page.evaluate(() => window.unifiedNativeFixture.snapshot()); expect(state.remote).toEqual(["fcm"]); expect(state.records).toHaveLength(0);
  expect(state.log.filter((x) => x === "0 PUT /api/push start")).toHaveLength(2);
});
test("FCM cannot overwrite a registration whose remote removal is pending", async ({ page }) => {
  await page.evaluate(async () => { await window.unifiedNativeFixture.enable(0); window.unifiedNativeFixture.controls({ delete: true }); await window.unifiedNativeFixture.remove(0).catch(() => undefined); });
  const before = await page.evaluate(() => window.unifiedNativeFixture.snapshot());
  const error = await page.evaluate(() => window.unifiedNativeFixture.fcm(0).then(() => "", (error: Error) => error.message));
  expect(error).toContain("清理"); expect(await page.evaluate(() => window.unifiedNativeFixture.snapshot())).toEqual(before);
});

test("an older native shell shows an update requirement and makes no registration writes", async ({ page }) => {
  await page.evaluate(() => { window.unifiedNativeFixture.controls({ oldNative: true }); window.unifiedNativeFixture.render(0); });
  await expect(page.getByRole("alert")).toHaveText("请更新 Android 客户端以启用多主机推送；已有注册保持不变。");
  expect((await page.evaluate(() => window.unifiedNativeFixture.snapshot())).log).toEqual([]);
});

test("failed new UP registration is rolled back and maintenance cannot replace FCM", async ({ page }) => {
  await page.evaluate(async () => { await window.unifiedNativeFixture.fcm(0); await window.unifiedNativeFixture.maintain(); window.unifiedNativeFixture.controls({ put: true }); });
  const error = await page.evaluate(() => window.unifiedNativeFixture.enable(0).then(() => "", (e: Error) => e.message)); expect(error).toContain("allowlisted");
  await page.evaluate(() => window.unifiedNativeFixture.maintain());
  const state = await page.evaluate(() => window.unifiedNativeFixture.snapshot()); expect(state.remote).toEqual(["fcm"]); expect(state.records).toHaveLength(0);
  expect(state.log.filter((x) => x === "0 PUT /api/push start")).toHaveLength(2);
});
test("an unconfirmed registration never auto-syncs even if rollback storage fails", async ({ page }) => {
  await page.evaluate(async () => { await window.unifiedNativeFixture.fcm(0); await window.unifiedNativeFixture.maintain(); window.unifiedNativeFixture.controls({ put: true, cleanupBefore: true }); await window.unifiedNativeFixture.enable(0).catch(() => undefined); await window.unifiedNativeFixture.maintain(); });
  const state = await page.evaluate(() => window.unifiedNativeFixture.snapshot()); expect(state.remote).toEqual(["fcm"]); expect(state.records[0]!.phase).toBe("active");
  expect(state.log.filter((x) => x === "0 PUT /api/push start")).toHaveLength(2);
});
test("settings does not report an unconfirmed distributor registration as connected", async ({ page }) => {
  await page.evaluate(async () => {
    await window.unifiedNativeFixture.fcm(0);
    window.unifiedNativeFixture.controls({ put: true, cleanupBefore: true });
    await window.unifiedNativeFixture.enable(0).catch(() => undefined);
    window.unifiedNativeFixture.render(0);
  });
  await expect(page.getByRole("button", { name: "连接分发器", exact: true })).toBeEnabled();
  await expect(page.getByText(/^此主机已注册到分发器/)).toHaveCount(0);
  expect((await page.evaluate(() => window.unifiedNativeFixture.snapshot())).remote).toEqual(["fcm"]);
});
test("the main enable action preserves UP even on a Hub without FCM", async ({ page }) => {
  await page.evaluate(async () => { await window.unifiedNativeFixture.enable(0); });
  const before = await page.evaluate(() => window.unifiedNativeFixture.snapshot());
  await page.evaluate(() => window.unifiedNativeFixture.resume(0));
  const after = await page.evaluate(() => window.unifiedNativeFixture.snapshot()); expect(after.remote).toEqual(["unifiedpush"]); expect(after.records[0]!.registrationId).toBe(before.records[0]!.registrationId);
});

test("legacy binding is performed locally without an online Hub", async ({ page }) => {
  const calls = await page.evaluate(() => window.unifiedNativeFixture.migrateOffline()); expect(calls).toHaveLength(1); expect(calls[0]!.migrateLegacy).toBe(true);
  expect((await page.evaluate(() => window.unifiedNativeFixture.snapshot())).log).toEqual([]);
});
test("connecting a distributor does not submit an unsaved quiet-hours draft", async ({ page }) => {
  await page.evaluate(() => window.unifiedNativeFixture.renderMain(0));
  await page.getByText("通知连接选项", { exact: true }).click();
  await openQuietHours(page); await page.getByLabel("勿扰开始", { exact: true }).fill("04:00");
  await page.getByRole("button", { name: "连接分发器", exact: true }).click();
  await expect(page.getByRole("button", { name: "断开分发器", exact: true })).toBeVisible();
  expect((await page.evaluate(() => window.unifiedNativeFixture.preferences(0))).quietStart).toBe("");
  await expect(page.getByLabel("勿扰开始", { exact: true })).toHaveValue("04:00");
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.unifiedNativeFixture.preferences(0).quietStart)).toBe("04:00");
});


test("provider changes retain their accepted enabled state when the settings refresh fails", async ({ page }) => {
  await page.evaluate(() => window.unifiedNativeFixture.renderMain(0));
  await page.getByText("通知连接选项", { exact: true }).click();
  await page.getByRole("switch", { name: "消息提醒", exact: true }).click();
  await expect(page.getByRole("switch", { name: "消息提醒", exact: true })).toHaveAttribute("aria-checked", "false");
  await page.evaluate(() => window.unifiedNativeFixture.controls({ refresh: true }));
  await page.getByRole("button", { name: "连接分发器", exact: true }).click();
  await expect(page.getByRole("switch", { name: "消息提醒", exact: true })).toHaveAttribute("aria-checked", "true");
  await expect(page.getByRole("alert")).toContainText("通知设置暂时无法刷新");
  await page.getByRole("button", { name: "断开分发器", exact: true }).click();
  await expect(page.getByRole("switch", { name: "消息提醒", exact: true })).toHaveAttribute("aria-checked", "false");
  expect((await page.evaluate(() => window.unifiedNativeFixture.preferences(0))) as { enabled?: boolean }).toMatchObject({ enabled: false });
});


test("successful distributor removal does not become a registration failure if the local status read fails", async ({ page }) => {
  await page.evaluate(async () => { await window.unifiedNativeFixture.enable(0); window.unifiedNativeFixture.renderMain(0); });
  await page.getByText("通知连接选项", { exact: true }).click();
  await expect(page.getByRole("button", { name: "断开分发器", exact: true })).toBeVisible();
  await page.evaluate(() => window.unifiedNativeFixture.controls({ nativeRead: true }));
  await page.getByRole("button", { name: "断开分发器", exact: true }).click();
  await expect(page.getByRole("switch", { name: "消息提醒", exact: true })).toHaveAttribute("aria-checked", "false");
  await expect(page.getByRole("alert")).toHaveText("暂时无法读取分发器状态，请刷新。");
  expect((await page.evaluate(() => window.unifiedNativeFixture.snapshot())).remote[0]).toBeUndefined();
  await page.evaluate(() => window.unifiedNativeFixture.controls({}));
  await page.getByRole("button", { name: "刷新", exact: true }).click();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "断开分发器", exact: true })).toHaveCount(0);
});


test("Android FCM ignores a retained error delivered after a new registration starts", async ({ page }) => {
  await page.evaluate(() => { const f = window.unifiedNativeFixture; f.firebase.hold = true; void f.fcm(0).then(() => { window.operationResult = "enabled"; }, () => { window.operationResult = "failed"; }); });
  await expect.poll(() => page.evaluate(() => window.unifiedNativeFixture.firebase.calls)).toContain("getToken");
  await page.evaluate(() => { const f = window.unifiedNativeFixture; f.firebase.emit("registrationError", { error: "previous request failed" }); f.firebase.release(0); });
  await expect.poll(() => page.evaluate(() => window.operationResult)).toBe("enabled");
  expect((await page.evaluate(() => window.unifiedNativeFixture.snapshot())).remote).toEqual(["fcm"]);
  expect(await page.evaluate(() => window.unifiedNativeFixture.firebase.calls)).not.toContain("legacy register");
});

test("Android FCM cannot use an unrelated retained token when its own request fails", async ({ page }) => {
  await page.evaluate(() => { const f = window.unifiedNativeFixture; f.firebase.hold = true; void f.fcm(0).then(() => { window.operationResult = "enabled"; }, () => { window.operationResult = "failed"; }); });
  await expect.poll(() => page.evaluate(() => window.unifiedNativeFixture.firebase.calls)).toContain("getToken");
  await page.evaluate(() => { const f = window.unifiedNativeFixture; f.firebase.emit("registration", { value: "obsolete-token" }); f.firebase.release(0, "firebase_registration_failed"); });
  await expect.poll(() => page.evaluate(() => window.operationResult)).toBe("failed");
  expect((await page.evaluate(() => window.unifiedNativeFixture.snapshot())).log).toEqual([]);
});


test("Android FCM timeout cannot write late receipts or settle a later attempt", async ({ page }) => {
  await page.clock.install(); await page.clock.pauseAt(new Date());
  await page.evaluate(() => { const f = window.unifiedNativeFixture; f.firebase.hold = true; void f.fcm(0).then(() => { window.operationResult = "unexpected"; }, (error: Error) => { window.operationResult = error.message; }); });
  await expect.poll(() => page.evaluate(() => window.unifiedNativeFixture.firebase.calls)).toContain("getToken");
  await page.clock.runFor(25_001);
  await expect.poll(() => page.evaluate(() => window.operationResult)).toContain("超时");
  await page.evaluate(() => { const f = window.unifiedNativeFixture; window.operationResult = "retrying"; void f.fcm(0).then(() => { window.operationResult = "enabled"; }); });
  await expect.poll(() => page.evaluate(() => window.unifiedNativeFixture.firebase.calls.filter(c => c === "getToken").length)).toBe(2);
  await page.evaluate(() => window.unifiedNativeFixture.firebase.release(0));
  expect((await page.evaluate(() => window.unifiedNativeFixture.snapshot())).log).toEqual([]);
  expect(await page.evaluate(() => window.operationResult)).toBe("retrying");
  await page.evaluate(() => window.unifiedNativeFixture.firebase.release(1));
  await expect.poll(() => page.evaluate(() => window.operationResult)).toBe("enabled");
  expect((await page.evaluate(() => window.unifiedNativeFixture.snapshot())).log.filter(c => c === "0 PUT /api/push done")).toHaveLength(1);
});

for (const [code, expected] of [
  ["firebase_not_configured", "此安装包未配置 Google 推送服务"],
  ["firebase_registration_failed", "无法连接 Google 推送服务"],
  ["firebase_cleanup_pending", "设备推送清理尚未完成"],
  ["UNIMPLEMENTED", "请更新 Android 客户端"],
]) test(`Android FCM ${code} explains recovery and never marks Hub notifications enabled`, async ({ page }) => {
  const error = await page.evaluate(async (code) => { const f = window.unifiedNativeFixture; f.firebase.error = code; return f.fcm(0).then(() => "unexpected", (error: Error) => error.message); }, code);
  expect(error).toContain(expected);
  expect((await page.evaluate(() => window.unifiedNativeFixture.snapshot())).log).toEqual([]);
});

test("Android rejects malformed token receipts before retiring the previous provider", async ({ page }) => {
  await page.evaluate(async () => { const f = window.unifiedNativeFixture; await f.enable(0); f.firebase.token = ""; });
  const before = await page.evaluate(() => window.unifiedNativeFixture.snapshot());
  await page.evaluate(() => window.unifiedNativeFixture.fcm(0).catch(() => undefined));
  expect(await page.evaluate(() => window.unifiedNativeFixture.snapshot())).toEqual(before);
});

test("whole-device cleanup keeps new registrations behind actual Firebase and delivered-notice cleanup", async ({ page }) => {
  await page.evaluate(() => { const f = window.unifiedNativeFixture; f.firebase.clearHold = true; void f.clear(); });
  await expect.poll(() => page.evaluate(() => window.unifiedNativeFixture.firebase.calls)).toContain("clearFirebase");
  await page.evaluate(() => { void window.unifiedNativeFixture.fcm(1).then(() => { window.operationResult = "enabled"; }); });
  // Let the permission and per-host admission promises progress.
  await page.waitForTimeout(50);
  expect(await page.evaluate(() => window.unifiedNativeFixture.firebase.calls)).not.toContain("getToken");
  await page.evaluate(() => window.unifiedNativeFixture.firebase.releaseClear?.());
  await expect.poll(() => page.evaluate(() => window.operationResult)).toBe("enabled");
  const calls = await page.evaluate(() => window.unifiedNativeFixture.firebase.calls);
  expect(calls.indexOf("clear delivered")).toBeLessThan(calls.indexOf("getToken"));
});
