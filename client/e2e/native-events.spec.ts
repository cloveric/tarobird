import { test, expect, type Page } from "@playwright/test";
import type { ViteDevServer } from "vite";
import { fileURLToPath } from "node:url";
import { createServer } from "./fixtures/vite.js";

type Fixture = {
  configure(platform: string, behavior?: Record<string, { fail?: number; hold?: boolean; replay?: unknown; remove?: "throw" | "reject"; removeEmit?: { name: string; value: unknown } }>, launch?: string): void;
  mountHost(): void; mountUpdates(): Promise<void>; unmountUpdates(): void; mountWorkspace(): Promise<void>; start(kind: "native" | "push"): void; stop(): void; emit(name: string, value: unknown): void; release(name: string): void;
  enable(): void;
  snapshot(): { resumes: number; enabling: string; navigations: { conversationId: string; hostId?: string }[]; errors: string[]; calls: string[]; handles: { name: string; removeCalls: number }[] };
};
declare global { interface Window { nativeEventsFixture: Fixture } }
let server: ViteDevServer;
test.beforeAll(async () => {
  const alias = (find: RegExp, file: string) => ({ find, replacement: fileURLToPath(new URL(`./fixtures/${file}.ts`, import.meta.url)) });
  server = await createServer({ resolve: { alias: [
    alias(/^@capacitor\/core$/, "native-events-core"), alias(/^@tauri-apps\/api\/core$/, "native-events-tauri"),
    alias(/^@capacitor\/(?:app|push-notifications)$/, "native-events-bridge"),
    alias(/^@tauri-apps\/api\/window$/, "native-events-bridge"),
    alias(/^@tauri-apps\/plugin-(?:deep-link|notification)$/, "native-events-bridge"),
  ] }, server: { host: "127.0.0.1", port: 0, strictPort: false } }); await server.listen();
});
test.afterAll(async () => { await server?.close(); });
test.beforeEach(async ({ page }) => {
  await page.goto(server.resolvedUrls!.local[0] + "e2e/fixtures/native-events.html");
  await page.waitForFunction(() => !!window.nativeEventsFixture);
});
const snap = (page: Page) => page.evaluate(() => window.nativeEventsFixture.snapshot());
test.afterEach(async ({ page }) => {
  await page.evaluate(() => window.nativeEventsFixture.stop());
  expect((await snap(page)).errors).toEqual([]);
});
test("failed launch URL read cannot disable foreground recovery or live links", async ({ page }) => {
  await page.evaluate(() => { const f = window.nativeEventsFixture; f.configure("ios", { launch: { fail: 1 } }); f.start("native"); });
  await expect.poll(async () => (await snap(page)).calls).toContain("appStateChange");
  await page.evaluate(() => { const f = window.nativeEventsFixture; f.emit("appStateChange", { isActive: true }); f.emit("appUrlOpen", { url: "tarocub://conversation/live" }); });
  expect((await snap(page)).resumes).toBe(1); expect((await snap(page)).navigations).toEqual([{ conversationId: "live", messageId: null }]);
});
test("HostApp removes successful listeners even when push registration fails", async ({ page }) => {
  await page.evaluate(() => { const f = window.nativeEventsFixture; f.configure("ios", { pushNotificationActionPerformed: { fail: 1 } }); f.mountHost(); });
  await expect.poll(async () => (await snap(page)).calls).toContain("appStateChange");
  await page.evaluate(() => window.nativeEventsFixture.stop());
  await expect.poll(async () => (await snap(page)).handles.filter((h) => h.name === "appUrlOpen" || h.name === "appStateChange").map((h) => h.removeCalls)).toEqual([1, 1]);
});
test("late cold-start URL cannot overwrite a live URL", async ({ page }) => {
  await page.evaluate(() => { const f = window.nativeEventsFixture; f.configure("ios", { launch: { hold: true } }, "tarocub://conversation/old"); f.start("native"); });
  await expect.poll(async () => (await snap(page)).calls).toContain("appUrlOpen");
  await page.evaluate(() => { const f = window.nativeEventsFixture; f.emit("appUrlOpen", { url: "tarocub://conversation/new" }); f.release("launch"); });
  expect((await snap(page)).navigations.map((n) => n.conversationId)).toEqual(["new"]);
});

test("one failed mobile listener retries independently without duplicate callbacks", async ({ page }) => {
  await page.evaluate(() => { const f = window.nativeEventsFixture; f.configure("android", { appUrlOpen: { fail: 1 } }); f.start("native"); });
  await expect.poll(async () => (await snap(page)).calls.filter((c) => c === "appUrlOpen").length).toBe(2);
  await page.evaluate(() => { const f = window.nativeEventsFixture; f.emit("appStateChange", { isActive: false }); f.emit("appStateChange", { isActive: true }); f.emit("appUrlOpen", { url: "tarocub://conversation/recovered" }); });
  const state = await snap(page); expect(state.resumes).toBe(1); expect(state.navigations).toHaveLength(1);
  expect(state.calls.filter((c) => c === "launch")).toHaveLength(1); expect(state.calls.filter((c) => c === "appStateChange")).toHaveLength(1);
});

test("foreground listener rejection does not block links and recovers on its own", async ({ page }) => {
  await page.evaluate(() => { const f = window.nativeEventsFixture; f.configure("ios", { appStateChange: { fail: 1 } }); f.start("native"); });
  await expect.poll(async () => (await snap(page)).calls.filter((c) => c === "appStateChange").length).toBe(2);
  await page.evaluate(() => { const f = window.nativeEventsFixture; f.emit("appStateChange", { isActive: true }); f.emit("appUrlOpen", { url: "tarocub://conversation/recovered" }); });
  expect((await snap(page)).resumes).toBe(1); expect((await snap(page)).navigations).toHaveLength(1);
});

test("retained mobile events work while registration is still pending", async ({ page }) => {
  await page.evaluate(() => { const f = window.nativeEventsFixture; f.configure("ios", { appUrlOpen: { hold: true, replay: { url: "tarocub://conversation/retained" } }, appStateChange: { hold: true, replay: { isActive: true } } }); f.start("native"); });
  await expect.poll(async () => (await snap(page)).resumes).toBe(1);
  expect((await snap(page)).navigations.map((n) => n.conversationId)).toEqual(["retained"]);
  await page.evaluate(() => { const f = window.nativeEventsFixture; f.release("appUrlOpen"); f.release("appStateChange"); });
  expect((await snap(page)).resumes).toBe(1); expect((await snap(page)).navigations).toHaveLength(1);
});

test("stop fences pending native registrations and removes late handles exactly once", async ({ page }) => {
  await page.evaluate(() => { const f = window.nativeEventsFixture; f.configure("ios", { launch: { hold: true }, appUrlOpen: { hold: true }, appStateChange: { hold: true } }, "tarocub://conversation/old"); f.start("native"); });
  await expect.poll(async () => (await snap(page)).calls).toContain("appStateChange");
  await page.evaluate(() => { const f = window.nativeEventsFixture; f.stop(); f.stop(); f.emit("appStateChange", { isActive: true }); f.emit("appUrlOpen", { url: "tarocub://conversation/old" }); f.release("launch"); f.release("appUrlOpen"); f.release("appStateChange"); });
  await expect.poll(async () => (await snap(page)).handles.map((h) => h.removeCalls)).toEqual([1, 1]);
  const state = await snap(page); expect(state.resumes).toBe(0); expect(state.navigations).toEqual([]);
});

test("HostApp unmount cleans completed listeners without waiting for a pending push bridge", async ({ page }) => {
  await page.evaluate(() => { const f = window.nativeEventsFixture; f.configure("ios", { pushNotificationActionPerformed: { hold: true } }); f.mountHost(); });
  await expect.poll(async () => (await snap(page)).calls).toContain("appStateChange");
  await expect.poll(async () => (await snap(page)).calls).toContain("pushNotificationActionPerformed");
  await page.evaluate(() => window.nativeEventsFixture.stop());
  await expect.poll(async () => (await snap(page)).handles.filter((h) => h.name !== "pushNotificationActionPerformed").map((h) => h.removeCalls)).toEqual([1, 1]);
  await page.evaluate(() => {
    const f = window.nativeEventsFixture;
    f.emit("pushNotificationActionPerformed", { notification: { data: { id: "notice", title: "TaroCub", body: "test", conversationId: "old", messageId: "message", kind: "answer", at: 1 } } });
    f.release("pushNotificationActionPerformed");
  });
  await expect.poll(async () => (await snap(page)).handles.find((h) => h.name === "pushNotificationActionPerformed")!.removeCalls).toBe(1);
  expect((await snap(page)).navigations).toEqual([]);
});

test("cleanup errors cannot retain active callbacks or prevent sibling cleanup", async ({ page }) => {
  await page.evaluate(() => { const f = window.nativeEventsFixture; f.configure("ios", { appUrlOpen: { remove: "throw", removeEmit: { name: "appStateChange", value: { isActive: true } } }, appStateChange: { remove: "reject" } }); f.start("native"); });
  await expect.poll(async () => (await snap(page)).calls).toContain("appStateChange");
  await page.evaluate(() => { const f = window.nativeEventsFixture; f.stop(); f.emit("appStateChange", { isActive: true }); f.emit("appUrlOpen", { url: "tarocub://conversation/old" }); });
  expect((await snap(page)).handles.map((h) => h.removeCalls)).toEqual([1, 1]);
  expect((await snap(page)).resumes).toBe(0); expect((await snap(page)).navigations).toEqual([]);
});

test("rejected push registration retries and only the current callback can navigate", async ({ page }) => {
  await page.evaluate(() => { const f = window.nativeEventsFixture; f.configure("ios", { pushNotificationActionPerformed: { fail: 1, remove: "reject" } }); f.start("push"); });
  await expect.poll(async () => (await snap(page)).calls.filter((c) => c === "pushNotificationActionPerformed").length).toBe(2);
  await page.evaluate(() => {
    const f = window.nativeEventsFixture, data = { id: "notice", title: "TaroCub", body: "test", conversationId: "new", messageId: "message", hostId: "hub_" + "a".repeat(64), kind: "answer", at: 1 };
    f.emit("pushNotificationActionPerformed", { notification: { data: { ...data, hostId: "invalid" } } });
    f.emit("pushNotificationActionPerformed", { notification: { data } }); f.stop();
    f.emit("pushNotificationActionPerformed", { notification: { data } });
  });
  expect((await snap(page)).navigations).toEqual([{ conversationId: "new", messageId: "message", hostId: "hub_" + "a".repeat(64) }]);
  expect((await snap(page)).calls.every((c) => c.includes("pushNotificationActionPerformed"))).toBe(true);
});

test("native APNs envelopes retain the validated notification destination", async ({ page }) => {
  await page.evaluate(() => { const f = window.nativeEventsFixture; f.configure("ios"); f.start("push"); });
  await expect.poll(async () => (await snap(page)).calls).toContain("pushNotificationActionPerformed");
  await page.evaluate(() => {
    const f = window.nativeEventsFixture;
    const data = { id: "apns_notice", title: "TaroCub", body: "Done", conversationId: "apns_chat", messageId: "apns_message", hostId: "hub_" + "a".repeat(64), kind: "answer", at: 1, aps: { alert: { title: "TaroBird", body: "Done" }, sound: "default" } };
    f.emit("pushNotificationActionPerformed", { notification: { data: { ...data, hostId: "invalid" } } });
    f.emit("pushNotificationActionPerformed", { notification: { data } });
  });
  expect((await snap(page)).navigations).toEqual([{ conversationId: "apns_chat", messageId: "apns_message", hostId: "hub_" + "a".repeat(64) }]);
});

test("late launch result cannot override a notification click", async ({ page }) => {
  await page.evaluate(() => { const f = window.nativeEventsFixture; f.configure("ios", { launch: { hold: true } }, "tarocub://conversation/old"); f.start("native"); f.start("push"); });
  await expect.poll(async () => (await snap(page)).calls).toContain("pushNotificationActionPerformed");
  await page.evaluate(() => { const f = window.nativeEventsFixture; f.emit("pushNotificationActionPerformed", { notification: { data: { id: "notice", title: "TaroCub", body: "test", conversationId: "new", messageId: "message", kind: "answer", at: 1 } } }); f.release("launch"); });
  expect((await snap(page)).navigations.map((n) => n.conversationId)).toEqual(["new"]);
});

test("permanent rejection backs off and stops after eight attempts", async ({ page }) => {
  await page.clock.install(); await page.clock.pauseAt(new Date());
  await page.evaluate(() => { const f = window.nativeEventsFixture; f.configure("ios", { appUrlOpen: { fail: 100 } }); f.start("native"); });
  await expect.poll(async () => (await snap(page)).calls.filter((c) => c === "appUrlOpen").length).toBe(1);
  for (const [delay, count] of [[1_000, 2], [2_000, 3], [5_000, 4], [15_000, 5], [30_000, 6], [30_000, 7], [30_000, 8]]) {
    await page.clock.runFor(delay!);
    await expect.poll(async () => (await snap(page)).calls.filter((c) => c === "appUrlOpen").length).toBe(count);
  }
  await page.clock.runFor(3_600_000);
  expect((await snap(page)).calls.filter((c) => c === "appUrlOpen")).toHaveLength(8);
  await page.evaluate(() => window.nativeEventsFixture.emit("appUrlOpen", { url: "tarocub://conversation/stale" }));
  expect((await snap(page)).navigations).toEqual([]);
});

test("an unresolved registration is never duplicated by elapsed time", async ({ page }) => {
  await page.clock.install(); await page.clock.pauseAt(new Date());
  await page.evaluate(() => { const f = window.nativeEventsFixture; f.configure("ios", { appUrlOpen: { hold: true } }); f.start("native"); });
  await expect.poll(async () => (await snap(page)).calls).toContain("appUrlOpen");
  await page.clock.runFor(600_000);
  expect((await snap(page)).calls.filter((c) => c === "appUrlOpen")).toHaveLength(1);
});

test("desktop live URLs survive a failed current URL lookup", async ({ page }) => {
  await page.evaluate(() => { const f = window.nativeEventsFixture; f.configure("tauri", { current: { fail: 1 } }); f.start("native"); });
  await expect.poll(async () => (await snap(page)).calls).toContain("openUrl");
  await expect.poll(async () => (await snap(page)).calls).toContain("tauri://focus");
  await page.evaluate(() => window.nativeEventsFixture.emit("openUrl", ["https://unrelated.invalid/", "tarocub://conversation/new"]));
  expect((await snap(page)).navigations.map((n) => n.conversationId)).toEqual(["new"]);
  await page.evaluate(() => { const f = window.nativeEventsFixture; f.stop(); f.emit("openUrl", ["tarocub://conversation/old"]); });
  expect((await snap(page)).navigations).toHaveLength(1); expect((await snap(page)).handles.map((h) => h.removeCalls)).toEqual([1, 1]);
});

test("desktop notification wins over late current URL and is fenced after stop", async ({ page }) => {
  await page.evaluate(() => { const f = window.nativeEventsFixture; f.configure("tauri", { current: { hold: true }, notificationAction: { hold: true, remove: "throw" } }, "tarocub://conversation/old"); f.start("native"); f.start("push"); });
  await expect.poll(async () => (await snap(page)).calls).toContain("notificationAction");
  await expect.poll(async () => (await snap(page)).calls).toContain("tauri://focus");
  await page.evaluate(() => {
    const f = window.nativeEventsFixture, extra = { id: "notice", title: "TaroCub", body: "test", conversationId: "new", messageId: "message", kind: "answer", at: 1 };
    f.emit("notificationAction", { extra }); f.release("current"); f.stop(); f.emit("notificationAction", { extra }); f.release("notificationAction");
  });
  await expect.poll(async () => (await snap(page)).handles.map((h) => h.removeCalls)).toEqual([1, 1, 1]);
  expect((await snap(page)).navigations.map((n) => n.conversationId)).toEqual(["new"]);
});

test("desktop notification action envelopes route valid payloads and ignore missing notifications", async ({ page }) => {
  await page.evaluate(() => { const f = window.nativeEventsFixture; f.configure("tauri"); f.start("push"); });
  await expect.poll(async () => (await snap(page)).calls).toContain("notificationAction");
  await page.evaluate(() => {
    const f = window.nativeEventsFixture;
    const extra = { id: "notice", title: "TaroCub", body: "test", conversationId: "new", messageId: "message", kind: "answer", at: 1 };
    f.emit("notificationAction", { actionId: "tap", inputValue: null, notification: null, extra: { ...extra, conversationId: "missing-notification" } });
    f.emit("notificationAction", { actionId: "tap", inputValue: null, notification: { extra: { ...extra, hostId: "invalid" } } });
    f.emit("notificationAction", { actionId: "tap", inputValue: null, notification: { extra } });
    f.stop();
    f.emit("notificationAction", { actionId: "tap", inputValue: null, notification: { extra: { ...extra, conversationId: "late" } } });
  });
  expect((await snap(page)).navigations.map((n) => n.conversationId)).toEqual(["new"]);
});

test("web hash navigation still validates links and stops with its owner", async ({ page }) => {
  await page.evaluate(() => { const f = window.nativeEventsFixture; f.configure("web"); history.replaceState(null, "", "#conversation=first"); f.start("native"); });
  expect((await snap(page)).navigations.map((n) => n.conversationId)).toEqual(["first"]);
  await page.evaluate(() => { location.hash = "conversation=invalid&host=untrusted"; });
  await page.waitForTimeout(30); expect((await snap(page)).navigations).toHaveLength(1);
  await page.evaluate(() => { location.hash = "conversation=second&message=target"; });
  await expect.poll(async () => (await snap(page)).navigations.map((n) => n.conversationId)).toEqual(["first", "second"]);
  await page.evaluate(() => { window.nativeEventsFixture.stop(); location.hash = "conversation=old"; });
  await page.waitForTimeout(30); expect((await snap(page)).navigations).toHaveLength(2); expect((await snap(page)).calls).toEqual([]);
});

for (const app of ["HostApp", "Workspace"] as const) test(`${app} closes native and push callbacks together before any SDK removal`, async ({ page }) => {
  await page.evaluate(async (app) => {
    const f = window.nativeEventsFixture;
    const data = { id: "notice", title: "TaroCub", body: "test", conversationId: "old", messageId: "message", kind: "answer", at: 1 };
    f.configure("ios", { appUrlOpen: { removeEmit: { name: "pushNotificationActionPerformed", value: { notification: { data } } } } });
    if (app === "HostApp") f.mountHost(); else await f.mountWorkspace();
  }, app);
  await expect.poll(async () => (await snap(page)).calls).toContain("appStateChange");
  await expect.poll(async () => (await snap(page)).calls).toContain("pushNotificationActionPerformed");
  await page.evaluate(() => window.nativeEventsFixture.stop());
  expect((await snap(page)).navigations).toEqual([]);
  expect((await snap(page)).handles.map((h) => h.removeCalls)).toEqual([1, 1, 1]);
});

test("cached conversations without Bot members remain readable without phantom Bot actions", async ({ page }) => {
  await page.evaluate(async () => { const f = window.nativeEventsFixture; f.configure("web"); await f.mountWorkspace(); });
  await expect(page.locator(".sidebar .conversation-row")).toHaveCount(2);
  await expect(page.locator(".sidebar .bot-identity")).toHaveCount(0);
  await page.locator(".sidebar").getByRole("button", { name: /^chosen/ }).click();
  await expect(page.getByRole("heading", { name: "chosen", exact: true })).toBeVisible();
  await page.locator(".sidebar").getByRole("button", { name: /^chosen/ }).click({ button: "right" });
  await expect(page.getByRole("menuitem", { name: "分组置顶", exact: true })).toBeVisible();
  expect((await snap(page)).errors).toEqual([]);
});

test("late startup link cannot take the user away from a manually chosen conversation", async ({ page }) => {
  await page.evaluate(async () => { const f = window.nativeEventsFixture; f.configure("ios", { launch: { hold: true } }, "tarocub://conversation/old"); await f.mountWorkspace(); });
  await expect.poll(async () => (await snap(page)).calls).toContain("launch");
  await page.locator(".sidebar").getByRole("button", { name: /^chosen/ }).click();
  await expect(page.getByRole("heading", { name: "chosen", exact: true })).toBeVisible();
  await page.evaluate(() => window.nativeEventsFixture.release("launch"));
  expect((await snap(page)).navigations).toEqual([]);
  await expect(page.getByRole("heading", { name: "chosen", exact: true })).toBeVisible();
});

for (const platform of ["ios", "tauri"] as const) test(`${platform} applies an untouched startup link exactly once`, async ({ page }) => {
  await page.evaluate((platform) => { const f = window.nativeEventsFixture; f.configure(platform, {}, "tarocub://conversation/start?message=first"); f.start("native"); }, platform);
  await expect.poll(async () => (await snap(page)).navigations).toEqual([{ conversationId: "start", messageId: "first" }]);
});

test("keyboard activation also prevents a delayed desktop startup redirect", async ({ page }) => {
  await page.evaluate(() => { const f = window.nativeEventsFixture; f.configure("tauri", { current: { hold: true } }, "tarocub://conversation/old"); f.start("native"); });
  await expect.poll(async () => (await snap(page)).calls).toContain("current");
  await page.keyboard.press("Tab");
  await page.evaluate(() => window.nativeEventsFixture.release("current"));
  expect((await snap(page)).navigations).toEqual([]);
});

for (const remove of ["throw", "reject"] as const) test(`notification enable settles despite cleanup ${remove}`, async ({ page }) => {
  await page.evaluate((remove) => { const f = window.nativeEventsFixture; f.configure("ios", { registration: { remove }, registrationError: { remove } }); f.enable(); }, remove);
  await expect.poll(async () => (await snap(page)).enabling).toBe("enabled");
  await page.evaluate(() => window.nativeEventsFixture.emit("registration", { value: "late-token" }));
  expect((await snap(page)).calls.filter((c) => c.startsWith("http "))).toEqual(["http /api/push", "http /api/notifications"]);
  expect((await snap(page)).handles.map((h) => h.removeCalls)).toEqual([1, 1]);
});

test("a handled launch URL is not replayed when an installer is replaced", async ({ page }) => {
  await page.evaluate(() => { const f = window.nativeEventsFixture; f.configure("ios", {}, "tarocub://conversation/start"); f.start("native"); });
  await expect.poll(async () => (await snap(page)).navigations).toHaveLength(1);
  await page.evaluate(() => { const f = window.nativeEventsFixture; f.stop(); f.start("native"); });
  await expect.poll(async () => (await snap(page)).calls.filter((c) => c === "appUrlOpen").length).toBe(2);
  expect((await snap(page)).navigations).toHaveLength(1);
});

test("disposing a failed installer cancels its scheduled retry", async ({ page }) => {
  await page.clock.install(); await page.clock.pauseAt(new Date());
  await page.evaluate(() => { const f = window.nativeEventsFixture; f.configure("ios", { appUrlOpen: { fail: 100 } }); f.start("native"); });
  await expect.poll(async () => (await snap(page)).calls).toContain("appUrlOpen");
  await page.evaluate(() => window.nativeEventsFixture.stop()); await page.clock.runFor(120_000);
  expect((await snap(page)).calls.filter((c) => c === "appUrlOpen")).toHaveLength(1);
});

test("an unmounted pending launch read does not consume the next install's link", async ({ page }) => {
  await page.evaluate(() => { const f = window.nativeEventsFixture; f.configure("ios", { launch: { hold: true } }, "tarocub://conversation/start"); f.start("native"); });
  await expect.poll(async () => (await snap(page)).calls).toContain("launch");
  await page.evaluate(() => { const f = window.nativeEventsFixture; f.stop(); f.start("native"); });
  await expect.poll(async () => (await snap(page)).calls.filter((c) => c === "launch").length).toBe(2);
  await page.evaluate(() => window.nativeEventsFixture.release("launch"));
  await expect.poll(async () => (await snap(page)).navigations.map((n) => n.conversationId)).toEqual(["start"]);
});

test("live notification consumes an older pending startup link across installer replacement", async ({ page }) => {
  await page.evaluate(() => { const f = window.nativeEventsFixture; f.configure("ios", { launch: { hold: true } }, "tarocub://conversation/old"); f.start("native"); f.start("push"); });
  await expect.poll(async () => (await snap(page)).calls).toContain("pushNotificationActionPerformed");
  await page.evaluate(() => {
    const f = window.nativeEventsFixture, data = { id: "notice", title: "TaroCub", body: "test", conversationId: "new", messageId: "message", kind: "answer", at: 1 };
    f.emit("pushNotificationActionPerformed", { notification: { data } }); f.stop(); f.start("native");
  });
  await expect.poll(async () => (await snap(page)).calls.filter((c) => c === "appUrlOpen").length).toBe(2);
  await page.evaluate(() => window.nativeEventsFixture.release("launch"));
  expect((await snap(page)).navigations.map((n) => n.conversationId)).toEqual(["new"]);
});

test("failed startup lookup is not retried after the user starts using the app", async ({ page }) => {
  await page.evaluate(() => { const f = window.nativeEventsFixture; f.configure("ios", { launch: { fail: 1 } }, "tarocub://conversation/old"); f.start("native"); });
  await expect.poll(async () => (await snap(page)).calls).toContain("appStateChange");
  await page.keyboard.press("Tab");
  await page.evaluate(() => { const f = window.nativeEventsFixture; f.stop(); f.start("native"); });
  await expect.poll(async () => (await snap(page)).calls.filter((c) => c === "appUrlOpen").length).toBe(2);
  expect((await snap(page)).navigations).toEqual([]);
  expect((await snap(page)).calls.filter((c) => c === "launch")).toHaveLength(1);
});

test("retained registration error does not fail a new enable before register is called", async ({ page }) => {
  await page.evaluate(() => { const f = window.nativeEventsFixture; f.configure("ios", { registrationError: { replay: { error: "old failure" } } }); f.enable(); });
  await expect.poll(async () => (await snap(page)).enabling).toBe("enabled");
  expect((await snap(page)).calls.filter((c) => c === "register")).toHaveLength(1);
});

test("registration error from the current request still fails without Hub writes", async ({ page }) => {
  await page.evaluate(() => { const f = window.nativeEventsFixture; f.configure("ios", { register: { fail: 1 } }); f.enable(); });
  await expect.poll(async () => (await snap(page)).enabling).toBe("failed");
  expect((await snap(page)).calls.filter((c) => c.startsWith("http "))).toEqual([]);
  expect((await snap(page)).handles.map((h) => h.removeCalls)).toEqual([1, 1]);
});

test("unsupported desktop notification actions do not keep allocating rejected channels", async ({ page }) => {
  await page.clock.install(); await page.clock.pauseAt(new Date());
  await page.evaluate(() => { const f = window.nativeEventsFixture; f.configure("tauri", { notificationAction: { fail: 100 } }); f.start("push"); });
  await expect.poll(async () => (await snap(page)).calls).toContain("notificationAction");
  await page.clock.runFor(120_000);
  expect((await snap(page)).calls.filter((c) => c === "notificationAction")).toHaveLength(1);
});


test("desktop activation wakes hosts independently of a pending startup URL", async ({ page }) => {
  await page.evaluate(() => { const f = window.nativeEventsFixture; f.configure("tauri", { current: { hold: true } }); f.start("native"); });
  await expect.poll(async () => (await snap(page)).calls).toContain("tauri://focus");
  await page.evaluate(() => { const f = window.nativeEventsFixture; f.emit("tauri://blur", {}); f.emit("tauri://focus", {}); });
  expect((await snap(page)).resumes).toBe(1);
  await page.evaluate(() => { const f = window.nativeEventsFixture; f.stop(); f.emit("tauri://focus", {}); f.release("current"); });
  expect((await snap(page)).resumes).toBe(1);
  await expect.poll(async () => (await snap(page)).handles.find(h => h.name === "tauri://focus")?.removeCalls).toBe(1);
});

test("desktop focus registration retries without stale or duplicate resumes", async ({ page }) => {
  await page.evaluate(() => { const f = window.nativeEventsFixture; f.configure("tauri", { "tauri://focus": { fail: 1 } }); f.start("native"); });
  await expect.poll(async () => (await snap(page)).calls.filter(c => c === "tauri://focus").length).toBe(2);
  await page.evaluate(() => window.nativeEventsFixture.emit("tauri://focus", {}));
  expect((await snap(page)).resumes).toBe(1);
  await page.evaluate(() => { const f = window.nativeEventsFixture; f.stop(); f.emit("tauri://focus", {}); });
  expect((await snap(page)).resumes).toBe(1);
});

test("desktop focus cleanup fences pending registration and late callbacks", async ({ page }) => {
  await page.evaluate(() => { const f = window.nativeEventsFixture; f.configure("tauri", { "tauri://focus": { hold: true, remove: "reject" } }); f.start("native"); });
  await expect.poll(async () => (await snap(page)).calls).toContain("tauri://focus");
  await page.evaluate(() => { const f = window.nativeEventsFixture; f.stop(); f.emit("tauri://focus", {}); f.release("tauri://focus"); });
  await expect.poll(async () => (await snap(page)).handles.find(h => h.name === "tauri://focus")?.removeCalls).toBe(1);
  expect((await snap(page)).resumes).toBe(0);
});

for (const platform of ["android", "ios", "web"] as const) test(`${platform} HostApp starts only its supported updater without opening settings`, async ({ page }) => {
  await page.evaluate(platform => { const f = window.nativeEventsFixture; f.configure(platform); f.mountHost(); }, platform);
  if (platform !== "web") await expect.poll(async () => (await snap(page)).calls).toContain("appStateChange");
  else await expect(page.getByText("empty fixture")).toBeVisible();
  if (platform === "android") {
    await expect.poll(async () => (await snap(page)).calls).toContain("android-update-status");
    await expect.poll(async () => (await snap(page)).calls).toContain("android-update-check");
    await page.evaluate(() => window.nativeEventsFixture.stop());
    await expect.poll(async () => (await snap(page)).calls).toContain("android-update-state remove");
  } else expect((await snap(page)).calls.filter(call => call.startsWith("android-update"))).toEqual([]);
});


test("Android settings share startup checks without duplicating or prematurely removing native listeners", async ({ page }) => {
  await page.evaluate(() => { const f = window.nativeEventsFixture; f.configure("android"); f.mountHost(); });
  await expect.poll(async () => (await snap(page)).calls.filter(c => c === "android-update-check")).toHaveLength(1);
  await page.evaluate(() => window.nativeEventsFixture.mountUpdates());
  await expect.poll(async () => (await snap(page)).calls.filter(c => c === "android-update-status")).toHaveLength(2);
  await expect(page.getByRole("button", { name: "检查更新", exact: true })).toBeEnabled();
  expect((await snap(page)).calls.filter(c => c === "android-update-check")).toHaveLength(1);
  expect((await snap(page)).handles.filter(h => h.name === "android-update-state").map(h => h.removeCalls)).toEqual([0]);
  await page.evaluate(() => window.nativeEventsFixture.unmountUpdates());
  expect((await snap(page)).handles.filter(h => h.name === "android-update-state").map(h => h.removeCalls)).toEqual([0]);
  await page.evaluate(() => window.nativeEventsFixture.stop());
  await expect.poll(async () => (await snap(page)).handles.filter(h => h.name === "android-update-state").map(h => h.removeCalls)).toEqual([1]);
});
