import { test, expect } from "@playwright/test";
import type { ViteDevServer } from "vite";
import { createServer } from "./fixtures/vite.js";
import { fileURLToPath } from "node:url";
declare global { interface Window { systemPushFixture: any } }
let server: ViteDevServer;
test.beforeAll(async () => { server = await createServer({ resolve: { alias: [
  { find: /^@capacitor\/app$/, replacement: fileURLToPath(new URL("./fixtures/system-push-app.ts", import.meta.url)) },
  { find: /^@capacitor\/core$/, replacement: fileURLToPath(new URL("./fixtures/system-push-core.ts", import.meta.url)) },
  { find: /^@capacitor\/push-notifications$/, replacement: fileURLToPath(new URL("./fixtures/system-push-notifications.ts", import.meta.url)) },
] }, server: { host: "127.0.0.1", port: 0, strictPort: false } }); await server.listen(); });
test.afterAll(async () => { await server?.close(); });
test.beforeEach(async ({ page }) => { await page.goto(server.resolvedUrls!.local[0] + "e2e/fixtures/system-push-native.html"); await page.waitForFunction(() => !!window.systemPushFixture); });
test("retained APNs broadcast is not a receipt; simultaneous hosts share a fresh read", async ({ page }) => {
  await page.evaluate(() => { const f = window.systemPushFixture; f.native.retained = true; f.native.auto = false; f.read("a"); f.read("b"); });
  await expect.poll(() => page.evaluate(() => window.systemPushFixture.native.calls)).toContain("APNs register");
  expect(await page.evaluate(() => window.systemPushFixture.results)).toEqual({});
  await page.evaluate(() => window.systemPushFixture.native.update("c".repeat(64)));
  await expect.poll(() => page.evaluate(() => window.systemPushFixture.results)).toEqual({ a: "c".repeat(64), b: "c".repeat(64) });
  expect(await page.evaluate(() => window.systemPushFixture.native.calls.filter((x: string) => x === "APNs register").length)).toBe(1);
});
test("APNs registration hint does not register again; foreground and token rotation do update", async ({ page }) => {
  await page.evaluate(() => window.systemPushFixture.start());
  await expect.poll(() => page.evaluate(() => window.systemPushFixture.patches.length)).toBeGreaterThan(0);
  await page.waitForTimeout(80);
  expect(await page.evaluate(() => window.systemPushFixture.native.calls.filter((x: string) => x === "APNs register").length)).toBe(1);
  await page.evaluate(() => window.systemPushFixture.native.update("d".repeat(64)));
  await expect.poll(() => page.evaluate(() => window.systemPushFixture.patches.at(-1)?.token)).toBe("d".repeat(64));
  await expect.poll(() => page.evaluate(() => window.systemPushFixture.native.calls)).toContain("appStateChange");
  await page.evaluate(() => window.systemPushFixture.foreground());
  await expect.poll(() => page.evaluate(() => window.systemPushFixture.native.calls.filter((x: string) => x === "APNs register").length)).toBe(2);
  await page.waitForTimeout(80);
  expect(await page.evaluate(() => window.systemPushFixture.native.calls.filter((x: string) => x === "APNs register").length)).toBe(2);
});
for (const stage of ["permission", "snapshot", "listen registration", "listen registrationError"]) test(`clearing while ${stage} waits prevents late native registration`, async ({ page }) => {
  await page.evaluate(stage => { const f = window.systemPushFixture; f.native.hold = stage; f.read("a"); }, stage);
  await expect.poll(() => page.evaluate(() => window.systemPushFixture.native.released.length)).toBe(1);
  await page.evaluate(() => { const f = window.systemPushFixture; f.cancel(); f.native.release(); });
  await expect.poll(() => page.evaluate(() => window.systemPushFixture.results.a)).toBe("error");
  await expect.poll(() => page.evaluate(() => window.systemPushFixture.native.listeners())).toBe(0);
  expect(await page.evaluate(() => window.systemPushFixture.native.calls)).not.toContain("APNs register");
});
test("native timeout cancels late registration and permits a fresh retry", async ({ page }) => {
  await page.clock.install();
  await page.evaluate(() => { const f = window.systemPushFixture; f.native.hold = "snapshot"; f.read("a"); });
  await expect.poll(() => page.evaluate(() => window.systemPushFixture.native.released.length)).toBe(1);
  await page.clock.fastForward(26_000);
  await expect.poll(() => page.evaluate(() => window.systemPushFixture.results.a)).toBe("error");
  await page.evaluate(() => { const f = window.systemPushFixture; f.native.release(); f.read("b"); });
  await expect.poll(() => page.evaluate(() => window.systemPushFixture.results.b)).toBe("a".repeat(64));
  expect(await page.evaluate(() => window.systemPushFixture.native.calls.filter((x: string) => x === "APNs register").length)).toBe(1);
});
test("APNs failure cannot reuse the previous token", async ({ page }) => {
  await page.evaluate(() => { const f = window.systemPushFixture; f.native.auto = false; f.read("a"); });
  await expect.poll(() => page.evaluate(() => window.systemPushFixture.native.calls)).toContain("APNs register");
  await page.evaluate(() => window.systemPushFixture.native.update("", true));
  await expect.poll(() => page.evaluate(() => window.systemPushFixture.results.a)).toBe("error");
});
test("denied OS permission and old native bridge never trigger registration or prompts", async ({ page }) => {
  await page.evaluate(() => { const f = window.systemPushFixture; f.native.permission = "denied"; f.read("a"); });
  await expect.poll(() => page.evaluate(() => window.systemPushFixture.results.a)).toBe("error");
  await page.evaluate(() => { const f = window.systemPushFixture; f.native.permission = "granted"; f.native.unavailable = true; f.read("b"); });
  await expect.poll(() => page.evaluate(() => window.systemPushFixture.results.b)).toBe("error");
  const calls = await page.evaluate(() => window.systemPushFixture.native.calls); expect(calls).not.toContain("APNs register"); expect(calls).not.toContain("PROMPT");
});
test("Android reads Task receipts and ignores token values from legacy broadcasts", async ({ page }) => {
  await page.evaluate(() => { const f = window.systemPushFixture; f.setPlatform("android"); f.native.hold = "FCM getToken"; f.read("a"); f.read("b"); });
  await expect.poll(() => page.evaluate(() => window.systemPushFixture.native.released.length)).toBe(1);
  await page.evaluate(() => { const f = window.systemPushFixture; f.native.emit("registration", { value: "wrong" }); });
  expect(await page.evaluate(() => window.systemPushFixture.results)).toEqual({});
  await page.evaluate(() => window.systemPushFixture.native.release());
  await expect.poll(() => page.evaluate(() => window.systemPushFixture.results)).toEqual({ a: "a".repeat(64), b: "a".repeat(64) });
  expect(await page.evaluate(() => window.systemPushFixture.native.calls)).not.toContain("APNs register");
});

test("whole-device cleanup cancels enable while the OS permission prompt waits", async ({ page }) => {
  await page.evaluate(() => { const f = window.systemPushFixture; f.native.hold = "PROMPT"; f.enable(); });
  await expect.poll(() => page.evaluate(() => window.systemPushFixture.native.released.length)).toBe(1);
  await page.evaluate(() => { const f = window.systemPushFixture; f.cancel(); f.native.release(); });
  await expect.poll(() => page.evaluate(() => window.systemPushFixture.results.enable)).toBe("error");
  const calls = await page.evaluate(() => window.systemPushFixture.native.calls); expect(calls).not.toContain("APNs register"); expect(calls).not.toContain("Hub write");
});

test("APNs writes declare the installed App's topic to a Hub that routes it", async ({ page }) => {
  await page.evaluate(() => window.systemPushFixture.enable());
  await expect.poll(() => page.evaluate(() => window.systemPushFixture.results.enable)).toBe("enabled");
  expect(await page.evaluate(() => window.systemPushFixture.writes[0])).toEqual({ provider: "apns", token: "a".repeat(64), topic: "com.tarobot.client" });
  await page.evaluate(() => window.systemPushFixture.start());
  await expect.poll(() => page.evaluate(() => window.systemPushFixture.patches[0])).toEqual({ provider: "apns", token: "a".repeat(64), topic: "com.tarobot.client", expectedRevision: "binding-1" });
});
test("an older Hub without APNs topic routing gets no registration, prompt or rotation", async ({ page }) => {
  await page.evaluate(() => { const f = window.systemPushFixture; f.hub.topics = undefined; f.enable(); });
  await expect.poll(() => page.evaluate(() => window.systemPushFixture.results.enable)).toBe("error");
  expect(await page.evaluate(() => window.systemPushFixture.results.enableError)).toContain("此主机版本无法为当前 App 路由 iOS 推送");
  await page.evaluate(() => { const f = window.systemPushFixture; f.hub.topics = ["com.tarocub.client"]; f.enable(); });
  await expect.poll(() => page.evaluate(() => window.systemPushFixture.results.enableError)).toContain("主机的 APNs 配置未包含当前 App");
  let calls = await page.evaluate(() => window.systemPushFixture.native.calls); expect(calls).not.toContain("PROMPT"); expect(calls).not.toContain("Hub write");
  await page.evaluate(() => { const f = window.systemPushFixture; f.hub.topics = undefined; f.start(); });
  await page.waitForTimeout(150);
  expect(await page.evaluate(() => window.systemPushFixture.patches)).toEqual([]);
});
