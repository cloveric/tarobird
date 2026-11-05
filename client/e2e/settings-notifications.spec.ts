import { openQuietHours } from "./fixtures/settings.js";
import { preparePairing } from "./fixtures/pairing-invite.js";
import { waitForClientOnline } from "./fixtures/mobile.js";
import { test, expect } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HubServer } from "../../src/hub/server.js";
import { openSettings, closeSettings } from "./fixtures/settings.js";

test("accepted live settings replace an older pending read without reopening the panel", async ({ page, context }) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "quiet-live-"));
  const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve("dist") });
  const other = await context.newPage();
  let closed = false, captured = false, returned = false, release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  try {
    await page.goto(hub.url); await preparePairing(page, hub); await page.getByRole("button", { name: "配对此设备", exact: true }).click();
    await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
    await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" }); await waitForClientOnline(page);
    // Another window for the same device identity. Separately paired devices
    // intentionally keep their own notification preferences.
    await other.goto(hub.url); await waitForClientOnline(other); await openSettings(other, "notifications");
    await page.route("**/api/notifications", async route => {
      if (captured || route.request().method() !== "GET") { await route.continue(); return; }
      const response = await route.fetch(); captured = true;
      await held; await route.fulfill({ response }); returned = true;
    });
    await openSettings(page, "notifications"); await expect.poll(() => captured).toBe(true);
    await openQuietHours(other); await other.getByLabel("勿扰开始", { exact: true }).fill("21:30");
    await other.getByLabel("勿扰结束", { exact: true }).fill("06:30");
    await other.getByRole("button", { name: "保存", exact: true }).click();
    await expect(page.getByLabel("勿扰开始", { exact: true })).toHaveValue("21:30");
    release(); await expect.poll(() => returned).toBe(true);
    await expect(page.getByLabel("勿扰开始", { exact: true })).toHaveValue("21:30");
    await expect(page.getByLabel("勿扰结束", { exact: true })).toHaveValue("06:30");
    await hub.close(); closed = true;
    await expect(page.getByText("当前离线，已保存的设置仍然保留。连接恢复后可修改。", { exact: true })).toBeVisible();
    await expect(page.getByLabel("勿扰开始", { exact: true })).toHaveValue("21:30");
    await expect(page.getByLabel("勿扰开始", { exact: true })).toBeDisabled();
    await expect(page.getByRole("button", { name: "重新检查", exact: true })).toBeDisabled();
  } finally { release(); await page.close(); await other.close(); if (!closed) await hub.close(); await rm(root, { recursive: true, force: true }); }
});

test.use({ serviceWorkers: "block" });

for (const phone of [false, true]) test(`quiet-hours drafts require an explicit discard (${phone ? "phone" : "desktop"})`, async ({ page }) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "quiet-draft-"));
  const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve("dist") });
  try {
    if (phone) await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(hub.url); await preparePairing(page, hub); await page.getByRole("button", { name: "配对此设备", exact: true }).click();
    await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
    await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" }); await waitForClientOnline(page);
    await openSettings(page, "notifications");
    await openQuietHours(page); await page.getByLabel("勿扰开始", { exact: true }).fill("22:00");
    await page.getByLabel("勿扰结束", { exact: true }).fill("08:00");
    await closeSettings(page);
    const confirm = page.getByRole("dialog", { name: "放弃未保存的修改？", exact: true });
    await expect(confirm).toBeVisible();
    await confirm.getByRole("button", { name: "继续编辑", exact: true }).click();
    
    await expect(page.getByLabel("勿扰开始", { exact: true })).toHaveValue("22:00");
    if (phone) await page.getByRole("button", { name: "返回设置分类", exact: true }).click();
    await page.getByRole("navigation", { name: "设置分类" }).getByRole("button", { name: /^网络与连接/ }).click();
    await page.getByRole("dialog", { name: "设置", exact: true }).getByRole("button", { name: /^设备与网络/ }).click();
    // Viewing the network is safe: the dirty notification draft stays mounted.
    await expect(confirm).toHaveCount(0);
    await page.getByRole("dialog", { name: "设备与网络", exact: true }).getByRole("button", { name: "关闭设备与网络", exact: true }).click();
    await page.getByRole("dialog", { name: "设置", exact: true }).getByRole("button", { name: /^设备与网络/ }).click();
    // Starting a new pairing leaves settings, so it must not discard that draft.
    await page.getByRole("dialog", { name: "设备与网络", exact: true }).getByRole("button", { name: /^此设备连接另一台主机/ }).click();
    await expect(confirm).toBeVisible();
    await confirm.getByRole("button", { name: "继续编辑", exact: true }).click();
    await expect(page.getByLabel("勿扰开始", { exact: true })).toHaveValue("22:00");
    await closeSettings(page);
    await confirm.getByRole("button", { name: "放弃修改", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "设置", exact: true })).toHaveCount(0);
    await openSettings(page, "notifications");
    await expect(page.getByLabel("勿扰开始", { exact: true })).toHaveValue("");
  } finally { await page.close(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});

test("unconfigured browser push cannot be enabled; quiet hours save independently", async ({ page }) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "settings-notifications-"));
  const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve("dist") });
  try {
    await page.goto(hub.url);
    await preparePairing(page, hub); await page.getByRole("button", { name: "配对此设备", exact: true }).click();
    await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
    await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" });
    await waitForClientOnline(page);
    await page.getByRole("button", { name: "设置", exact: true }).click();
    await page.getByRole("navigation", { name: "设置分类" }).getByRole("button", { name: /^通知/ }).click();
    await expect(page.getByRole("switch", { name: "消息提醒", exact: true })).toBeDisabled();
    await openQuietHours(page); await page.getByLabel("勿扰开始", { exact: true }).fill("22:00");
    await page.getByLabel("勿扰结束", { exact: true }).fill("07:00");
    const saved = async () => {
      const row = await hub.store.db.get<{ preferences_json: string }>("SELECT preferences_json FROM device_preferences LIMIT 1");
      return row ? JSON.parse(row.preferences_json) : undefined;
    };
    expect(await saved()).toBeUndefined();
    await page.getByRole("navigation", { name: "设置分类" }).getByRole("button", { name: /^通用/ }).click();
    await page.getByRole("navigation", { name: "设置分类" }).getByRole("button", { name: /^通知/ }).click();
    await expect(page.getByLabel("勿扰开始", { exact: true })).toHaveValue("22:00");
    expect(await saved()).toBeUndefined();
    await page.getByRole("button", { name: "保存", exact: true }).click();
    await expect.poll(saved).toMatchObject({ enabled: false, quietStart: "22:00", quietEnd: "07:00" });
    await page.getByRole("button", { name: "关闭设置", exact: true }).click();
    await page.getByRole("button", { name: "设置", exact: true }).click();
    await page.getByRole("navigation", { name: "设置分类" }).getByRole("button", { name: /^通知/ }).click();
    await expect(page.getByLabel("勿扰开始", { exact: true })).toHaveValue("22:00");
    await expect(page.getByLabel("勿扰结束", { exact: true })).toHaveValue("07:00");
    await expect(page.getByRole("switch", { name: "消息提醒", exact: true })).toBeDisabled();
  } finally { await page.close(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});

test("online initial-load failure offers retry without pretending to be offline", async ({ page }) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "quiet-load-"));
  const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve("dist") });
  let fail = true;
  let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
  await page.route("**/api/notifications", async route => { if (fail) await route.fulfill({ status: 503, json: { error: "fixture_load_failure" } }); else { await held; await route.continue(); } });
  try {
    await page.goto(hub.url); await preparePairing(page, hub); await page.getByRole("button", { name: "配对此设备", exact: true }).click();
    await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
    await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" }); await waitForClientOnline(page);
    await openSettings(page, "notifications");
    await expect(page.getByRole("alert")).toContainText("未能读取主机上的通知设置，请重试。");
    await expect(page.getByText("连接主机后即可设置通知。", { exact: true })).toHaveCount(0);
    // Keyboard activation starts with focus on the button on both engines;
    // Safari does not focus a button on a pointer click by default.
    fail = false; await page.getByRole("button", { name: "重新检查", exact: true }).press("Enter");
    await expect(page.getByRole("button", { name: "检查中…", exact: true })).toBeFocused();
    await expect(page.getByRole("button", { name: "检查中…", exact: true })).toHaveAttribute("aria-disabled", "true");
    await expect(page.getByRole("alert")).toContainText("未能读取主机上的通知设置，请重试。");
    release();
    await openQuietHours(page); await expect(page.getByLabel("勿扰开始", { exact: true })).toBeVisible();
    await expect(page.getByRole("alert")).toHaveCount(0);
  } finally { release(); await page.close(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});

test("write failure preserves draft; successful write survives a failed refresh and blocks exit only while writing", async ({ page, context }) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "quiet-write-"));
  const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve("dist") });
  let mode: "normal" | "reject" | "hold" | "refresh-fail" = "normal", writes = 0, entered = false, refreshedDuringWrite = false;
  const other = await context.newPage();
  let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
  await page.route("**/api/notifications", async route => {
    if (route.request().method() === "PUT") {
      writes++;
      if (mode === "reject") { await route.fulfill({ status: 503, json: { error: "fixture_write_failure" } }); return; }
      if (mode === "hold") { entered = true; await held; mode = "refresh-fail"; }
    } else if (mode === "hold") { const response = await route.fetch(); if ((await response.json()).preferences.quietStart === "18:00") refreshedDuringWrite = true; await route.fulfill({ response }); return; } else if (mode === "refresh-fail") { await route.fulfill({ status: 503, json: { error: "fixture_refresh_failure" } }); return; }
    await route.continue();
  });
  try {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(hub.url); await preparePairing(page, hub); await page.getByRole("button", { name: "配对此设备", exact: true }).click();
    await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
    await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" }); await waitForClientOnline(page);
    await openSettings(page, "notifications");
    await openQuietHours(page); await page.getByLabel("勿扰开始", { exact: true }).fill("23:00");
    await page.getByLabel("勿扰结束", { exact: true }).fill("07:30");
    mode = "reject"; await page.getByRole("button", { name: "保存", exact: true }).click();
    await expect(page.locator(".settings-quiet").getByRole("alert")).toContainText("fixture_write_failure");
    await expect(page.getByLabel("勿扰开始", { exact: true })).toHaveValue("23:00");
    await closeSettings(page);
    await page.getByRole("button", { name: "继续编辑", exact: true }).click();
    await expect(page.getByLabel("勿扰结束", { exact: true })).toHaveValue("07:30");
    await other.goto(hub.url); await waitForClientOnline(other); await openSettings(other, "notifications");
    mode = "hold"; await page.getByRole("button", { name: "保存", exact: true }).click();
    await expect.poll(() => entered).toBe(true);
    await expect(page.getByRole("button", { name: "返回设置分类", exact: true })).toBeDisabled();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("heading", { name: "通知", level: 2, exact: true })).toBeVisible();
    expect(writes).toBe(2);
    await openQuietHours(other); await other.getByLabel("勿扰开始", { exact: true }).fill("18:00");
    await other.getByLabel("勿扰结束", { exact: true }).fill("19:00");
    await other.getByRole("button", { name: "保存", exact: true }).click();
    await expect.poll(() => refreshedDuringWrite).toBe(true);
    release();
    await expect(page.locator(".quiet-save-row").getByRole("status")).toHaveText("勿扰时段已保存");
    await expect(page.getByRole("alert")).toContainText("通知设置暂时无法刷新");
    await expect(page.locator(".settings-quiet").getByRole("alert")).toHaveCount(0);
    await expect(page.getByLabel("勿扰开始", { exact: true })).toHaveValue("23:00");
    await expect(page.getByLabel("勿扰结束", { exact: true })).toHaveValue("07:30");
    const row = await hub.store.db.get<{ preferences_json: string }>("SELECT preferences_json FROM device_preferences LIMIT 1");
    expect(JSON.parse(row!.preferences_json)).toMatchObject({ quietStart: "23:00", quietEnd: "07:30" });
    mode = "normal"; await page.getByRole("alert").getByRole("button", { name: "重新检查", exact: true }).click();
    await expect(page.getByRole("alert")).toHaveCount(0);
    await closeSettings(page);
    await expect(page.getByRole("dialog", { name: "设置", exact: true })).toHaveCount(0);
    await expect(page.getByRole("dialog", { name: "放弃未保存的修改？", exact: true })).toHaveCount(0);
  } finally { release(); await other.close(); await page.close(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});

test("a pre-write read arriving after a failed post-write refresh cannot erase the write receipt", async ({ page }) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "quiet-stale-receipt-"));
  const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve("dist") });
  let captured = false, returned = false, wrote = false, release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  try {
    await page.goto(hub.url); await preparePairing(page, hub); await page.getByRole("button", { name: "配对此设备", exact: true }).click();
    await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
    await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" }); await waitForClientOnline(page);
    await openSettings(page, "notifications"); await openQuietHours(page); await expect(page.getByLabel("勿扰开始", { exact: true })).toBeVisible(); await closeSettings(page);
    await page.route("**/api/notifications", async route => {
      if (route.request().method() === "PUT") { wrote = true; await route.continue(); return; }
      if (wrote) { await route.fulfill({ status: 503, json: { error: "fixture_refresh_failure" } }); return; }
      if (captured) { await route.continue(); return; }
      const response = await route.fetch(); captured = true; await held; await route.fulfill({ response }); returned = true;
    });
    await openSettings(page, "notifications"); await expect.poll(() => captured).toBe(true);
    await openQuietHours(page); await page.getByLabel("勿扰开始", { exact: true }).fill("23:00");
    await page.getByLabel("勿扰结束", { exact: true }).fill("06:00");
    await page.getByRole("button", { name: "保存", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("通知设置暂时无法刷新");
    release(); await expect.poll(() => returned).toBe(true);
    await expect(page.getByLabel("勿扰开始", { exact: true })).toHaveValue("23:00");
    await expect(page.getByLabel("勿扰结束", { exact: true })).toHaveValue("06:00");
    await expect(page.locator(".quiet-save-row").getByRole("status")).toHaveText("勿扰时段已保存");
    await expect(page.getByRole("button", { name: "重新检查", exact: true })).toHaveCount(1);
    await closeSettings(page);
    await expect(page.getByRole("dialog", { name: "放弃未保存的修改？", exact: true })).toHaveCount(0);
  } finally { release(); await page.close(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});
