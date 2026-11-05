import { preparePairing } from "./fixtures/pairing-invite.js";
import { test, expect, type Page } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HubServer } from "../../src/hub/server.js";
import { openSettings, closeSettings, openDevicePairing, closeDevicePairing } from "./fixtures/settings.js";
import { waitForClientOnline } from "./fixtures/mobile.js";

test.use({ serviceWorkers: "block" });
async function fixture(page: Page) {
  const root = await mkdtemp(path.join(os.tmpdir(), "settings-devices-"));
  const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve("dist") });
  await page.goto(hub.url); await preparePairing(page, hub); await page.getByRole("button", { name: "配对此设备", exact: true }).click();
  await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
  await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" }); await waitForClientOnline(page);
  await hub.store.db.run("INSERT INTO devices(id,user_id,name,platform,public_key,created_at,last_seen) VALUES('phone','owner','测试手机','android','fixture',1,1)");
  return { hub, dispose: async () => { await page.close(); await hub.close(); await rm(root, { recursive: true, force: true }); } };
}

const detail = (page: Page) => page.getByRole("dialog", { name: "管理设备", exact: true });
async function manage(page: Page, name = "测试手机") {
  await page.locator(".device-row").filter({ hasText: name }).getByRole("button", { name: "管理", exact: true }).click();
}
async function rename(page: Page, name = "测试手机") {
  if (!await detail(page).isVisible()) await manage(page, name);
  await detail(page).getByRole("button", { name: `重命名设备 ${name}`, exact: true }).click();
}
async function backToList(page: Page) { await detail(page).getByRole("button", { name: "返回设备列表", exact: true }).click(); }

for (const phone of [false, true]) {
  test(`successful device revocation survives a failed list refresh (${phone ? "phone" : "desktop"})`, async ({ page }, info) => {
    if (phone) await page.setViewportSize({ width: 390, height: 844 });
    const { hub, dispose } = await fixture(page);
    try {
      await openSettings(page, "devices");
      const row = page.locator(".device-row").filter({ hasText: "测试手机" });
      await expect(row).toBeVisible();
      await page.route("**/api/devices", route => route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "fixture_unavailable" }) }));
      await manage(page); await detail(page).getByRole("button", { name: "撤销授权", exact: true }).click();
      await page.getByRole("dialog", { name: "撤销设备授权？", exact: true }).getByRole("button", { name: "撤销授权", exact: true }).click();
      await expect.poll(async () => (await hub.store.db.get<{ revoked: number }>("SELECT revoked FROM devices WHERE id='phone'"))?.revoked).toBe(1);
      await expect(detail(page).getByText("已撤销授权", { exact: true })).toBeVisible();
      await expect(page.getByRole("status").filter({ hasText: "已撤销「测试手机 · Android」的授权" })).toBeVisible();
      await expect(page.getByRole("status").filter({ hasText: "已撤销「测试手机 · Android」的授权" })).toBeFocused();
      await page.screenshot({ path: info.outputPath(`device-revoke-${phone ? "phone" : "desktop"}.png`) });
      await expect(row.getByRole("button", { name: "撤销授权", exact: true })).toHaveCount(0);
      await expect(page.getByText("设备列表未能刷新，已完成的操作仍然有效。", { exact: true })).toBeVisible();
    } finally { await dispose(); }
  });
}

test("device rename keeps its acknowledged name when list refresh fails", async ({ page }) => {
  const { hub, dispose } = await fixture(page);
  try {
    await openSettings(page, "devices");
    await rename(page);
    await page.getByLabel("设备新名称", { exact: true }).fill("出差手机");
    await page.route("**/api/devices", route => route.fulfill({ status: 503, contentType: "application/json", body: '{"error":"fixture_unavailable"}' }));
    await page.getByRole("button", { name: "保存", exact: true }).click();
    await expect.poll(async () => (await hub.store.db.get<{ name: string }>("SELECT name FROM devices WHERE id='phone'"))?.name).toBe("出差手机");
    await expect(page.getByRole("button", { name: "重命名设备 出差手机", exact: true })).toBeVisible();
    await expect(page.getByText("重命名失败", { exact: true })).toHaveCount(0);
  } finally { await dispose(); }
});

test("device-name drafts survive a cancelled return from device details", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const { dispose } = await fixture(page);
  try {
    await openSettings(page, "devices");
    await rename(page);
    await page.getByLabel("设备新名称", { exact: true }).fill("未保存的新名称");
    await backToList(page);
    const confirmation = page.getByRole("dialog", { name: "放弃设备名称修改？", exact: true });
    await expect(confirmation).toBeVisible();
    await confirmation.getByRole("button", { name: "继续编辑", exact: true }).click();
    await expect(page.getByLabel("设备新名称", { exact: true })).toHaveValue("未保存的新名称");
  } finally { await dispose(); }
});

test("device-list retry recovers initial failure and keeps keyboard focus", async ({ page }) => {
  const { dispose } = await fixture(page);
  let fail = true, held = false, gets = 0, release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  try {
    await page.route("**/api/devices", async route => {
      ++gets;
      if (fail) { await route.fulfill({ status: 503, contentType: "application/json", body: '{"error":"fixture_unavailable"}' }); return; }
      held = true; await pending; await route.continue();
    });
    await openSettings(page, "devices");
    await expect(page.getByText("暂时无法读取设备列表，请重试。", { exact: true })).toBeVisible();
    await expect(page.getByText("没有可显示的设备。", { exact: true })).toHaveCount(0);
    fail = false;
    await page.getByRole("button", { name: "刷新设备列表", exact: true }).press("Enter");
    await expect.poll(() => held).toBe(true);
    const refreshing = page.getByRole("button", { name: "正在刷新…", exact: true });
    await expect(refreshing).toBeFocused(); await refreshing.press("Enter");
    expect(gets).toBe(2);
    release();
    await expect(page.locator(".device-row").filter({ hasText: "测试手机" })).toBeVisible();
    await expect(page.getByRole("button", { name: "刷新设备列表", exact: true })).toBeFocused();
    await expect(page.getByText("暂时无法读取设备列表，请重试。", { exact: true })).toHaveCount(0);
  } finally { release(); await dispose(); }
});

test("a slow device-list read cannot restore revoked authorization", async ({ page }) => {
  const { dispose } = await fixture(page);
  let captured = false, returned = false, release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  try {
    await openSettings(page, "devices");
    const row = page.locator(".device-row").filter({ hasText: "测试手机" });
    await expect(row).toBeVisible();
    await page.route("**/api/devices", async route => {
      if (captured) { await route.fulfill({ status: 503, contentType: "application/json", body: '{"error":"fixture_unavailable"}' }); return; }
      const response = await route.fetch(); captured = true; await pending; await route.fulfill({ response }); returned = true;
    });
    await page.getByRole("button", { name: "刷新设备列表", exact: true }).click();
    await expect.poll(() => captured).toBe(true);
    await manage(page); await detail(page).getByRole("button", { name: "撤销授权", exact: true }).click();
    await page.getByRole("dialog", { name: "撤销设备授权？", exact: true }).getByRole("button", { name: "撤销授权", exact: true }).click();
    await expect(detail(page).getByText("已撤销授权", { exact: true })).toBeVisible();
    await expect(page.getByText("设备列表未能刷新，已完成的操作仍然有效。", { exact: true })).toBeVisible();
    release(); await expect.poll(() => returned).toBe(true);
    await expect(detail(page).getByText("已撤销授权", { exact: true })).toBeVisible();
    await expect(row.getByRole("button", { name: "撤销授权", exact: true })).toHaveCount(0);
  } finally { release(); await dispose(); }
});

test("renaming guards in-flight writes, preserves rejected drafts and supports retry", async ({ page }) => {
  const { hub, dispose } = await fixture(page);
  let fail = true, requested = false, puts = 0, release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  try {
    await openSettings(page, "devices");
    await rename(page);
    const input = page.getByLabel("设备新名称", { exact: true });
    await input.fill("   "); await expect(page.getByRole("button", { name: "保存", exact: true })).toBeDisabled();
    await input.fill("出差手机");
    await page.route("**/api/devices/rename", async route => {
      ++puts;
      if (fail) { await route.fulfill({ status: 400, contentType: "application/json", body: '{"error":"invalid_request"}' }); return; }
      requested = true; await pending; await route.continue();
    });
    await page.getByRole("button", { name: "保存", exact: true }).click();
    await expect(page.getByRole("alert")).toHaveCount(1); await expect(page.getByRole("alert")).toHaveText("操作未完成，请检查输入内容后重试。"); await expect(input).toHaveValue("出差手机"); await expect(input).toBeFocused();
    fail = false; await page.getByRole("button", { name: "保存", exact: true }).click(); await expect.poll(() => requested).toBe(true);
    await expect(page.getByRole("button", { name: "关闭设置", exact: true })).toBeDisabled();
    await expect(page.getByRole("button", { name: "刷新设备列表", exact: true })).toBeDisabled();
    await expect(input).toBeDisabled();
    await page.keyboard.press("Escape"); await expect(page.getByRole("dialog", { name: "设置", exact: true })).toBeVisible();
    expect(puts).toBe(2); release();
    await expect(page.getByRole("button", { name: "重命名设备 出差手机", exact: true })).toBeFocused();
    await expect.poll(async () => (await hub.store.db.get<{ name: string }>("SELECT name FROM devices WHERE id='phone'"))?.name).toBe("出差手机");
    await backToList(page); await closeSettings(page); await expect(page.getByRole("dialog", { name: "放弃未保存的修改？", exact: true })).toHaveCount(0);
  } finally { release(); await dispose(); }
});

test("pair approval remains successful when rereading devices fails; retry discovers the new device", async ({ page, browser }) => {
  const { hub, dispose } = await fixture(page);
  const secondContext = await browser.newContext(); const second = await secondContext.newPage();
  try {
    await openSettings(page, "devices");
    await expect(page.locator(".device-row").filter({ hasText: "测试手机" })).toBeVisible();
    await second.goto(hub.url); await second.getByLabel("设备名称", { exact: true }).fill("新电脑");
    await preparePairing(second, hub); await second.getByRole("button", { name: "配对此设备", exact: true }).click();
    await openDevicePairing(page); await page.getByLabel("新设备配对码", { exact: true }).fill(await second.getByLabel("配对码", { exact: true }).innerText());
    await page.route("**/api/devices", route => route.fulfill({ status: 503, contentType: "application/json", body: '{"error":"fixture_unavailable"}' }));
    await page.getByRole("button", { name: "确认配对", exact: true }).click();
    await expect(page.getByRole("status").filter({hasText: /已在.+确认新设备/})).toBeVisible(); await page.getByRole("button",{name:"上一步",exact:true}).click();
    await expect(page.getByLabel("新设备配对码", { exact: true })).toHaveValue(""); await closeDevicePairing(page);
    await second.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" }); await waitForClientOnline(second);
    await page.unroute("**/api/devices"); await page.getByRole("button", { name: "刷新设备列表", exact: true }).click();
    await expect(page.locator(".device-row").filter({ hasText: "新电脑" })).toBeVisible();
    await expect(page.getByText("设备列表未能刷新，已完成的操作仍然有效。", { exact: true })).toHaveCount(0);
  } finally { await secondContext.close(); await dispose(); }
});

test("offline device-name editing keeps its draft but cannot submit", async ({ page }) => {
  const { hub, dispose } = await fixture(page);
  try {
    await openSettings(page, "devices");
    await rename(page);
    const input = page.getByLabel("设备新名称", { exact: true }); await input.fill("旅行手机");
    await hub.close();
    await expect(page.getByRole("dialog", { name: "管理设备", exact: true }).getByText("连接恢复后即可操作", { exact: true })).toBeVisible();
    await expect(input).toHaveValue("旅行手机"); await expect(input).toBeDisabled();
    await expect(page.getByRole("button", { name: "保存", exact: true })).toBeDisabled();
    await page.getByRole("button", { name: "取消", exact: true }).click();
    await backToList(page); await closeSettings(page); await expect(page.getByRole("dialog", { name: "设置", exact: true })).toHaveCount(0);
  } finally { await dispose(); }
});


test("device feedback follows language changes and a narrow screen keeps controls inside the card", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 844 });
  const { dispose } = await fixture(page);
  try {
    await openSettings(page, "devices");
    await rename(page);
    await page.getByLabel("设备新名称", { exact: true }).fill("My travel phone");
    await page.getByRole("button", { name: "保存", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "设备名称已更新" })).toBeVisible();
    await backToList(page); await page.getByRole("button", { name: "返回设置分类", exact: true }).click();
    await page.getByRole("navigation", { name: "设置分类" }).getByRole("button", { name: /^通用/ }).click();
    await page.getByLabel("主题", { exact: true }).selectOption("dark");
    await page.getByLabel("语言", { exact: true }).selectOption("en");
    await page.getByRole("button", { name: "Back to settings categories", exact: true }).click();
    await page.getByRole("navigation", { name: "Settings categories" }).getByRole("button", { name: /^Devices/ }).click();
    await expect(page.getByRole("status").filter({ hasText: "Device name updated" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Refresh device list", exact: true })).toBeInViewport();
    const row = page.locator(".device-row").filter({ hasText: "My travel phone" });
    expect(await row.evaluate(element => [...element.querySelectorAll("button")].every(button => {
      const bounds = button.getBoundingClientRect(), parent = element.getBoundingClientRect();
      return bounds.left >= parent.left - 1 && bounds.right <= parent.right + 1 && bounds.height >= 44;
    }))).toBe(true);
    await expect(row.getByRole("button", { name: "Manage", exact: true })).toBeVisible();
  } finally { await dispose(); }
});

for (const operation of ["revoke", "rename"] as const) test(`lost ${operation} acknowledgment reconciles the list without repeating the write`, async ({ page }) => {
  const { hub, dispose } = await fixture(page); let writes = 0;
  try {
    await openSettings(page, "devices");
    await expect(page.locator(".device-row").filter({ hasText: "测试手机" })).toBeVisible();
    await page.route(`**/api/devices/${operation}`, async route => {
      ++writes;
      // Commit against the real Hub, then lose only the acknowledgment.
      const response = await route.fetch(); expect(response.ok()).toBe(true); await route.abort("failed");
    });
    if (operation === "revoke") {
      await manage(page); await detail(page).getByRole("button", { name: "撤销授权", exact: true }).click();
      await page.getByRole("dialog", { name: "撤销设备授权？", exact: true }).getByRole("button", { name: "撤销授权", exact: true }).click();
      await expect(detail(page).getByText("已撤销授权", { exact: true })).toBeVisible();
      await expect.poll(async () => (await hub.store.db.get<{ revoked: number }>("SELECT revoked FROM devices WHERE id='phone'"))?.revoked).toBe(1);
    } else {
      await rename(page);
      await page.getByLabel("设备新名称", { exact: true }).fill("回执丢失的新名称");
      await page.getByRole("button", { name: "保存", exact: true }).click();
      await expect(page.getByLabel("设备新名称", { exact: true })).toBeFocused();
      await expect.poll(async () => (await hub.store.db.get<{ name: string }>("SELECT name FROM devices WHERE id='phone'"))?.name).toBe("回执丢失的新名称");
    }
    await expect(page.getByRole("alert")).toHaveCount(1);
    await expect(page.getByRole("alert")).toHaveText("未能确认操作结果。请核对更新后的设备列表，再决定是否重试。");
    if (operation === "rename") {
      await page.getByRole("button", { name: "取消", exact: true }).click();
      await expect(page.getByRole("button", { name: "重命名设备 回执丢失的新名称", exact: true })).toBeVisible();
    }
    expect(writes).toBe(1);
  } finally { await dispose(); }
});
