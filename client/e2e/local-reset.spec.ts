import { preparePairing } from "./fixtures/pairing-invite.js";
import { clickAppAction } from "./fixtures/desktop-actions.js";
import { waitForClientOnline } from "./fixtures/mobile.js";
import { test, expect } from "@playwright/test";
import { createServer } from "./fixtures/vite.js";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HubServer } from "../../src/hub/server.js";
import type { ClientCache } from "../src/storage.js";
import { openSettings } from "./fixtures/settings.js";

test("native key confirmation stays recoverable through cancellation and never opens pairing early", async ({ page }, info) => {
  const server = await createServer({ server: { port: 0, strictPort: false, host: "127.0.0.1" } }); await server.listen();
  let sockets = 0; page.on("websocket", (socket) => { if (new URL(socket.url()).pathname === "/ws") sockets++; });
  try {
    const url = server.resolvedUrls!.local[0]!;
    await page.goto(url + "e2e/fixtures/stream.html"); await page.waitForFunction(() => "streamCache" in window);
    await page.evaluate(async () => {
      const cache = (window as unknown as { streamCache: ClientCache }).streamCache;
      await cache.saveIdentity({ deviceId: "device_native_reset", keyRef: "device_native_reset", name: "native fixture", publicKey: "fixture", routes: [] });
      await cache.beginReset();
    });
    // This is a controllable IPC double, not OS Keychain acceptance. An unresolved
    // request must keep the durable key reference and the disconnected UI intact.
    await page.addInitScript(() => {
      const calls: unknown[] = [];
      const hostChecks: unknown[] = [];
      Object.assign(window, { isTauri: true, nativeResetCalls: calls, nativeHostChecks: hostChecks, __TAURI_INTERNALS__: { invoke: (command: string, args: unknown) => {
        if (command === "desktop_migration_mode") return Promise.resolve({ transition: false, appVersion: "1.0.119" });
        if (command === "desktop_migration_status") return Promise.resolve({ exports: [], imported: [] });
        if (command === "desktop_notifications_supported") return Promise.resolve(true);
        if (command === "desktop_notification_context") return Promise.resolve("fixture-document");
        if (command === "desktop_notification_clear") return Promise.resolve();
        // After cleanup the real native runtime reports an unconfigured host.
        // Do not turn this key-cleanup fixture into an unrelated startup failure.
        if (command === "desktop_host" && ["resume", "status"].includes((args as { action?: string })?.action ?? "")) {
          hostChecks.push(args); return Promise.resolve({ available: true, running: false });
        }
        if (command !== "device_forget") return Promise.reject(new Error(`unexpected_native_command:${command}`));
        calls.push(args);
        return new Promise<void>((resolve, reject) => Object.assign(window, { settleNativeReset: (allow: boolean) => allow ? resolve() : reject("device_key_delete_failed") }));
      } } });
    });
    await page.goto(url);
    const resetRecord = () => page.evaluate(async () => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => { const request = indexedDB.open("tarocub-v1"); request.onsuccess = () => resolve(request.result); request.onerror = reject; });
      try { return await new Promise<unknown>((resolve, reject) => { const request = db.transaction("settings").objectStore("settings").get("pendingReset"); request.onsuccess = () => resolve(request.result); request.onerror = reject; }); } finally { db.close(); }
    });
    await expect(page.getByRole("status")).toContainText("正在清理设备密钥");
    await expect(page.getByText(/^系统可能正在等待钥匙串或安全存储确认/)).toBeVisible();
    await expect(page.getByRole("button", { name: "重试清理", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "配对此设备", exact: true })).toHaveCount(0);
    expect(await resetRecord()).toBe(JSON.stringify({ keyRef: "device_native_reset" })); expect(sockets).toBe(0);
    expect(await page.evaluate(() => (window as unknown as { nativeHostChecks: unknown[] }).nativeHostChecks)).toEqual([]);
    await page.setViewportSize({ width: 390, height: 844 }); await page.screenshot({ path: info.outputPath("native-key-confirmation.png") });
    await page.evaluate(() => (window as unknown as { settleNativeReset(allow: boolean): void }).settleNativeReset(false));
    await expect(page.getByRole("alert")).toContainText("未能清理设备密钥");
    expect(await resetRecord()).toBe(JSON.stringify({ keyRef: "device_native_reset" }));
    await page.getByRole("button", { name: "重试清理", exact: true }).click();
    await expect(page.getByRole("status")).toContainText("正在清理设备密钥");
    await expect.poll(() => page.evaluate(() => (window as unknown as { nativeResetCalls: unknown[] }).nativeResetCalls)).toEqual([{ keyRef: "device_native_reset" }, { keyRef: "device_native_reset" }]);
    await page.evaluate(() => (window as unknown as { settleNativeReset(allow: boolean): void }).settleNativeReset(true));
    await expect(page.getByRole("heading", { name: "从这台电脑开始" })).toBeVisible();
    expect(await page.evaluate(() => (window as unknown as { nativeHostChecks: unknown[] }).nativeHostChecks)).toContainEqual({ action: "resume" });
    expect(await resetRecord()).toBeUndefined(); expect(sockets).toBe(0);
    await page.setViewportSize({ width: 1200, height: 820 });
    await page.screenshot({ path: info.outputPath("desktop-fresh-after-reset.png") });
  } finally { await page.close(); await server.close(); }
});

test("reset fences delayed cache writes and other tabs even after a new pairing", async ({ page, context }) => {
  const server = await createServer({ server: { port: 0, strictPort: false, host: "127.0.0.1" } }); await server.listen();
  const oldTab = await context.newPage();
  try {
    const url = server.resolvedUrls!.local[0] + "e2e/fixtures/stream.html";
    for (const tab of [page, oldTab]) { await tab.goto(url); await tab.waitForFunction(() => "streamCache" in window); }
    await page.evaluate(async () => {
      const cache = (window as unknown as { streamCache: ClientCache }).streamCache;
      await cache.saveIdentity({ deviceId: "device_old", keyRef: "device_old", name: "old", publicKey: "old", routes: [] });
      await cache.markIdentityRevoked((await cache.identity())!);
      await cache.saveDraft("old", "private draft");
      await cache.saveAttachment("old", new Blob(["private file"]));
    });
    const result = await oldTab.evaluate(async () => {
      const cache = (window as unknown as { streamCache: ClientCache }).streamCache;
      let release!: (bytes: ArrayBuffer) => void;
      const file = new Blob(["late private file"]); file.arrayBuffer = () => new Promise((resolve) => { release = resolve; });
      const late = cache.saveAttachment("late", file).then(() => "written", (error: Error) => error.message);
      await cache.beginReset(); release(new ArrayBuffer(1));
      return { late: await late, marker: await cache.pendingReset(), identity: (await cache.identity())?.deviceId };
    });
    expect(result).toEqual({ late: "local_reset_in_progress", marker: { keyRef: "device_old" }, identity: "device_old" });
    await page.reload(); await page.waitForFunction(() => "streamCache" in window);
    await page.evaluate(async () => {
      const cache = (window as unknown as { streamCache: ClientCache }).streamCache;
      await cache.finishReset();
      await cache.saveIdentity({ deviceId: "device_new", name: "new", publicKey: "new", routes: [] });
      await cache.saveDraft("new", "new draft");
    });
    const stale = await oldTab.evaluate(async () => {
      const cache = (window as unknown as { streamCache: ClientCache }).streamCache;
      const rejected = (work: Promise<unknown>) => work.then(() => "written", (error: Error) => error.message);
      return Promise.all([rejected(cache.saveDraft("old", "stale draft")), rejected(cache.saveIdentity({ deviceId: "device_old", keyRef: "device_old", name: "old", publicKey: "old", routes: [] })), rejected(cache.saveAttachment("late", new Blob(["stale"]))), rejected(cache.markIdentityRevoked({ deviceId: "device_old", name: "old", publicKey: "old", routes: [] }))]);
    });
    expect(stale).toEqual(Array(4).fill("local_reset_in_progress"));
    expect(await page.evaluate(async () => { const cache = (window as unknown as { streamCache: ClientCache }).streamCache; return cache.identityRevoked((await cache.identity())!); })).toBe(false);
    expect(await page.evaluate(async () => { const cache = (window as unknown as { streamCache: ClientCache }).streamCache; return { identity: (await cache.identity())?.deviceId, old: await cache.draft("old"), current: await cache.draft("new"), attachment: !!await cache.attachment("late"), pending: !!await cache.pendingReset() }; })).toEqual({ identity: "device_new", old: "", current: "new draft", attachment: false, pending: false });
  } finally { await oldTab.close(); await server.close(); }
});

test("failed local purge survives restart, stays disconnected and can retry without losing the recovery record", async ({ page }, info) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "reset-recovery-"));
  const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve("dist") });
  let sockets = 0;
  page.on("websocket", (socket) => { if (new URL(socket.url()).pathname === "/ws") sockets++; });
  await page.addInitScript(() => {
    const clear = IDBObjectStore.prototype.clear;
    IDBObjectStore.prototype.clear = function () {
      if (this.name === "messages" && localStorage.getItem("fail-test-reset") === "true") { this.transaction.abort(); throw new Error("injected_purge_failure"); }
      return clear.call(this);
    };
  });
  try {
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','助手','fixture')");
    const conversation = await hub.store.createConversation("owner", ["alpha"], "历史仍保留", "reset");
    await page.goto(hub.url); await preparePairing(page, hub); await page.getByRole("button", { name: "配对此设备", exact: true }).click();
    await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
    await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" }); await waitForClientOnline(page);
    await page.getByRole("textbox", { name: "消息", exact: true }).fill("清理前的私人草稿");
    await openSettings(page); await page.getByLabel("主题", { exact: true }).selectOption("dark");
    const paletteChoice = page.locator('input[name="color-palette"]').nth(1); await paletteChoice.check(); const selectedPalette = await paletteChoice.inputValue();
    await page.getByRole("navigation", { name: "设置分类" }).getByRole("button", { name: /^网络与连接/ }).click();
    await page.evaluate(() => localStorage.setItem("fail-test-reset", "true"));
    await page.getByRole("dialog", { name: "设置", exact: true }).getByRole("button", { name: /^此设备的连接(?: |$)/ }).click(); await page.getByRole("button", { name: "从此设备移除", exact: true }).click(); await expect(page.getByRole("dialog", { name: `从此设备移除「${(await hub.profile.read()).name}」？`, exact: true })).toContainText("1 份草稿"); await page.getByRole("button", { name: "确认移除", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "此设备的连接", exact: true }).getByRole("alert")).toContainText("injected_purge_failure");
    await expect(page.getByRole("textbox", { name: "消息", exact: true })).toHaveCount(0);
    const initialSockets = sockets;
    const readSettings = () => page.evaluate(async () => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => { const request = indexedDB.open("tarocub-v1"); request.onsuccess = () => resolve(request.result); request.onerror = reject; });
      try { return await new Promise<Record<string, unknown>>((resolve) => { const tx = db.transaction("settings"); const keys = tx.objectStore("settings").getAllKeys(), values = tx.objectStore("settings").getAll(); tx.oncomplete = () => resolve(Object.fromEntries(keys.result.map((key, index) => [String(key), values.result[index]]))); }); } finally { db.close(); }
    });
    const failed = await readSettings(); expect(failed.identity).toBeTruthy(); expect(failed.pendingReset).toBe("{}"); expect(failed[`draft:${conversation.id}`]).toBe("清理前的私人草稿");
    await page.reload();
    // Recovery renders a direct control after registry hydration, without the
    // ordinary workspace menu. Wait for that surface before choosing a route.
    await expect(page.getByRole("button", { name: "设备与网络", exact: true })).toBeVisible();
    await clickAppAction(page, "设备与网络", page.getByRole("button", { name: "设备与网络", exact: true })); await page.getByRole("dialog", { name: "设备与网络", exact: true }).getByRole("button", { name: "此设备的连接", exact: true }).click(); await expect(page.getByRole("button", { name: "重试清理", exact: true })).toBeVisible(); expect(sockets).toBe(initialSockets);
    await page.setViewportSize({ width: 390, height: 844 }); await page.screenshot({ path: info.outputPath("reset-recovery-phone.png") });
    await page.evaluate(() => localStorage.removeItem("fail-test-reset")); await page.getByRole("button", { name: "重试清理", exact: true }).click();
    await expect(page.getByRole("heading", { name: "连接你的 TaroBird" })).toBeVisible();
    const completed = await readSettings(); expect(Object.keys(completed).filter((key) => key !== "preferences")).toEqual(["cacheGeneration"]); expect(await page.evaluate(() => document.documentElement.dataset.palette)).toBe(selectedPalette);
    expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe("dark"); expect(sockets).toBe(initialSockets);
    expect((await hub.store.conversations("owner")).map((item) => item.id)).toContain(conversation.id);
    expect(((await hub.store.devices("owner")).filter(device => device.id !== "pairing_fixture_owner"))[0]?.revoked).toBe(0);
  } finally { await page.close(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});
