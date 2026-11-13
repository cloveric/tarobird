import { test, expect, type Page } from "@playwright/test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { HubServer } from "../../src/hub/server.js";
import { preparePairing } from "./fixtures/pairing-invite.js";
import { openWorkspacePage, waitForClientOnline } from "./fixtures/mobile.js";

test.use({ serviceWorkers: "block" });
async function fixture(page: Page, openSettings = true) {
  const root = await mkdtemp(path.join(os.tmpdir(), "engine-path-ui-"));
  const executable = path.join(root, "Example CLI"); await writeFile(executable, "fixture; never run"); await chmod(executable, 0o700);
  const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve("dist"), managedBots: { entrypoint: path.resolve("../dist/src/index.js"), env: { HOME: root, PATH: root, TAROBOT_MODEL_DISCOVERY: "0" } } });
  try {
    await hub.profile.update({ name: "Example host", revision: (await hub.profile.read()).revision });
    await page.goto(hub.url); await preparePairing(page, hub); await page.getByRole("button", { name: "配对此设备", exact: true }).click();
    await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
    await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" }); await waitForClientOnline(page);
    const open = async () => { await openWorkspacePage(page, "设置"); await page.getByRole("navigation", { name: "设置分类" }).getByRole("button", { name: /^引擎程序/ }).click(); };
    if (openSettings) await open();
    return { root, executable, hub, open, panel: page.locator(".engine-settings:visible"), dispose: async () => { await page.close(); await hub.close(); await rm(root, { recursive: true, force: true }); } };
  } catch (error) { await page.close(); await hub.close(); await rm(root, { recursive: true, force: true }); throw error; }
}
for (const width of [1360, 390]) test(`manual paths, validation, reset and private host scope at ${width}px`, async ({ page }, info) => {
  await page.setViewportSize({ width, height: 960 }); const f = await fixture(page);
  try {
    const row = f.panel.getByRole("region", { name: "Codex", exact: true });
    await expect(row).toContainText("未检测到 CLI");
    await row.getByRole("button", { name: "指定路径", exact: true }).click();
    await row.getByLabel("Codex CLI 程序路径").fill("~/codex");
    await row.getByRole("button", { name: "保存路径", exact: true }).click();
    await expect(f.panel.getByRole("alert")).toContainText("完整绝对路径");
    await row.getByLabel("Codex CLI 程序路径").fill(f.executable);
    await row.getByLabel("Codex CLI 程序路径").press("Enter");
    await expect(f.panel.getByText("已保存并核实。", { exact: true })).toBeVisible();
    await expect(row).toContainText("已检测到 CLI"); await expect(row).toContainText("手动指定");
    await expect(f.panel).toContainText("已运行的 Bot 请在空闲后重启");
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
    await f.panel.scrollIntoViewIfNeeded(); await page.screenshot({ path: info.outputPath(`engine-paths-${width}.png`) });
    await page.reload(); await waitForClientOnline(page); await f.open();
    await expect(row).toContainText(f.executable);
    await row.getByRole("button", { name: "清除手动路径", exact: true }).click();
    await expect(f.panel.getByText("已保存并核实。", { exact: true })).toBeVisible();
    await expect(row).toContainText("未检测到 CLI");
    expect(f.hub.engineSettings.status().engines.find(e => e.id === "codex")?.override).toBeNull();
    // Localization and the default theme share existing settings controls.
    if (width < 760) await page.getByRole("button", { name: "返回设置分类", exact: true }).click();
    await page.getByRole("navigation", { name: "设置分类" }).getByRole("button", { name: /^通用/ }).click();
    await page.locator("#theme").selectOption("dark"); await page.locator("#language").selectOption("en");
    if (width < 760) await page.getByRole("button", { name: "Back to settings categories", exact: true }).click();
    await page.getByRole("navigation", { name: "Settings categories" }).getByRole("button", { name: /^Engine programs/ }).click();
    await expect(row).toContainText("CLI not detected"); await expect(f.panel).toContainText("Paths belong to the host");
    await f.panel.scrollIntoViewIfNeeded(); await page.screenshot({ path: info.outputPath(`engine-paths-en-dark-${width}.png`) });
  } finally { await f.dispose(); }
});
test("stale and lost save responses require read-back without repeating the write", async ({ page }) => {
  const f = await fixture(page);
  try {
    const row = f.panel.getByRole("region", { name: "Codex", exact: true });
    await row.getByRole("button", { name: "指定路径", exact: true }).click(); await row.getByLabel("Codex CLI 程序路径").fill(f.executable);
    await f.hub.engineSettings.update({ engine: "kimi", path: f.executable, revision: "default", requestId: "other-device" }, apply => apply());
    await row.getByRole("button", { name: "保存路径", exact: true }).click();
    await expect(f.panel.getByRole("alert")).toContainText("设置已变化"); await expect(row.getByRole("button", { name: "保存路径", exact: true })).toBeDisabled();
    await f.panel.getByRole("button", { name: "放弃修改并重新读取", exact: true }).click();
    await row.getByRole("button", { name: "指定路径", exact: true }).click(); await row.getByLabel("Codex CLI 程序路径").fill(f.executable);
    let writes = 0;
    await page.route("**/api/settings/engines", async route => { if (route.request().method() !== "PUT") return route.continue(); writes++; await route.fetch(); await route.abort("failed"); });
    await row.getByRole("button", { name: "保存路径", exact: true }).click();
    await expect(f.panel.getByRole("alert")).toContainText("保存结果未确认"); expect(writes).toBe(1);
    expect(f.hub.engineSettings.status().engines.find(e => e.id === "codex")?.override).toBe(f.executable);
    await f.panel.getByRole("button", { name: "放弃修改并重新读取", exact: true }).click();
    await expect(row).toContainText("已检测到 CLI"); expect(writes).toBe(1);
  } finally { await f.dispose(); }
});
test("members cannot read private executable paths", async ({ page }) => {
  const f = await fixture(page);
  try {
    await f.hub.store.db.run("UPDATE users SET role='member' WHERE id='owner'");
    let requests = 0; await page.route("**/api/settings/engines*", route => { requests++; return route.continue(); });
    await page.reload(); await waitForClientOnline(page); await f.open();
    await expect(f.panel).toContainText("仅主机所有者可以查看和修改引擎路径。"); expect(requests).toBe(0);
  } finally { await f.dispose(); }
});
for (const width of [1360, 390]) test(`new Bot repairs a missing path without submitting on Enter at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 960 });
  const f = await fixture(page, false);
  try {
    let creations = 0;
    await page.route("**/api/bots", route => { if (route.request().method() === "POST") { creations++; return route.fulfill({ status: 409, json: { error: "fixture" } }); } return route.continue(); });
    await page.getByRole("button", { name: "新建", exact: true }).filter({ visible: true }).click();
    await page.getByRole("button", { name: "新建 Bot", exact: true }).or(page.getByRole("menuitem", { name: "新建 Bot", exact: true })).click();
    await page.getByLabel("Bot 名称", { exact: true }).fill("Example Bot");
    await page.getByText("找不到引擎？检查 CLI 路径", { exact: true }).click();
    const row = f.panel.getByRole("region", { name: "Codex", exact: true });
    await row.getByRole("button", { name: "指定路径", exact: true }).click();
    await row.getByLabel("Codex CLI 程序路径").fill(f.executable); await row.getByLabel("Codex CLI 程序路径").press("Enter");
    await expect(f.panel.getByText("已保存并核实。", { exact: true })).toBeVisible();
    await page.getByText("找不到引擎？检查 CLI 路径", { exact: true }).click();
    await expect(page.getByLabel("Bot 名称", { exact: true })).toHaveValue("Example Bot");
    await expect(page.getByRole("button", { name: "创建 Bot", exact: true })).toBeEnabled(); expect(creations).toBe(0);
  } finally { await f.dispose(); }
});
