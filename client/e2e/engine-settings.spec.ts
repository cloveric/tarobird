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
for (const width of [1360, 390, 320]) test(`manual paths, validation, reset and private host scope at ${width}px`, async ({ page }, info) => {
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
for (const width of [1360, 390]) test(`IME confirmation does not save a path or submit the surrounding new-Bot form at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 960 });
  const f = await fixture(page, false);
  try {
    let writes = 0, creations = 0;
    await page.route("**/api/settings/engines", route => { if (route.request().method() === "PUT") writes++; return route.continue(); });
    await page.route("**/api/bots", route => { if (route.request().method() === "POST") creations++; return route.fulfill({ status: 409, json: { error: "fixture" } }); });
    await page.getByRole("button", { name: "新建", exact: true }).filter({ visible: true }).click();
    await page.getByRole("button", { name: "新建 Bot", exact: true }).or(page.getByRole("menuitem", { name: "新建 Bot", exact: true })).click();
    const row = f.panel.getByRole("region", { name: "Codex", exact: true });
    await page.getByText("找不到引擎？检查 CLI 路径", { exact: true }).click();
    await row.getByRole("button", { name: "指定路径", exact: true }).click();
    const input = row.getByLabel("Codex CLI 程序路径");
    await input.fill(f.executable);
    for (const composition of [{ isComposing: true }, { keyCode: 229 }]) {
      await input.dispatchEvent("keydown", { key: "Enter", bubbles: true, ...composition });
      await expect(input).toBeEnabled();
      expect(writes).toBe(0); expect(creations).toBe(0);
      await expect(input).toBeVisible();
    }
    await input.press("Enter");
    await expect(f.panel.getByText("已保存并核实。", { exact: true })).toBeVisible();
    expect(writes).toBe(1); expect(creations).toBe(0);
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
test("refreshing paths keeps the selected engine and model in a new Bot", async ({ page }) => {
  const f = await fixture(page, false);
  try {
    for (const engine of ["codex", "claude"] as const) await f.hub.engineSettings.update({ engine, path: f.executable, requestId: `seed-${engine}`, revision: f.hub.engineSettings.status().revision }, apply => apply());
    await page.getByRole("button", { name: "新建", exact: true }).filter({ visible: true }).click();
    await page.getByRole("button", { name: "新建 Bot", exact: true }).or(page.getByRole("menuitem", { name: "新建 Bot", exact: true })).click();
    await page.getByLabel("Bot 名称", { exact: true }).fill("Example Claude");
    const engine = page.getByRole("combobox", { name: "引擎", exact: true });
    await engine.selectOption("claude");
    const model = page.getByRole("combobox", { name: "模型", exact: true });
    const alternatives = await model.locator("option").evaluateAll(options => options.map(option => (option as HTMLOptionElement).value));
    await model.selectOption(alternatives.find(value => value !== "" && value !== "default") ?? alternatives[0]);
    const chosenModel = await model.inputValue();
    const effort = page.getByRole("combobox", { name: "推理强度（effort）", exact: true });
    const efforts = await effort.locator("option").evaluateAll(options => options.map(option => (option as HTMLOptionElement).value));
    await effort.selectOption(efforts.at(-1)!); const chosenEffort = await effort.inputValue();
    const permission = page.getByRole("combobox", { name: "权限与批准", exact: true });
    await permission.selectOption("normal");
    await page.getByText("找不到引擎？检查 CLI 路径", { exact: true }).click();
    const row = f.panel.getByRole("region", { name: "Claude Code", exact: true });
    await row.getByRole("button", { name: "指定路径", exact: true }).click();
    const refreshed = page.waitForResponse(response => response.url().endsWith("/api/bots/catalog"));
    await row.getByRole("button", { name: "保存路径", exact: true }).click();
    await refreshed;
    await expect(f.panel.getByText("已保存并核实。", { exact: true })).toBeVisible();
    await page.getByText("找不到引擎？检查 CLI 路径", { exact: true }).click();
    await expect(engine).toHaveValue("claude");
    await expect(model).toHaveValue(chosenModel);
    await expect(effort).toHaveValue(chosenEffort); await expect(permission).toHaveValue("normal");
    await expect(page.getByLabel("Bot 名称", { exact: true })).toHaveValue("Example Claude");
    await page.getByText("找不到引擎？检查 CLI 路径", { exact: true }).click();
    const cleared = page.waitForResponse(response => response.url().endsWith("/api/bots/catalog"));
    await row.getByRole("button", { name: "清除手动路径", exact: true }).click();
    await cleared;
    await page.getByText("找不到引擎？检查 CLI 路径", { exact: true }).click();
    await expect(engine).toHaveValue("codex");
    await expect(page.getByRole("button", { name: "创建 Bot", exact: true })).toBeEnabled();
  } finally { await f.dispose(); }
});
test("a pending path save prevents creating a Bot with the old path", async ({ page }) => {
  const f = await fixture(page, false);
  let release = () => {};
  try {
    await f.hub.engineSettings.update({ engine: "codex", path: f.executable, requestId: "seed", revision: "default" }, apply => apply());
    await page.getByRole("button", { name: "新建", exact: true }).filter({ visible: true }).click();
    await page.getByRole("button", { name: "新建 Bot", exact: true }).or(page.getByRole("menuitem", { name: "新建 Bot", exact: true })).click();
    await page.getByLabel("Bot 名称", { exact: true }).fill("Example Bot");
    const create = page.getByRole("button", { name: "创建 Bot", exact: true });
    await expect(create).toBeEnabled();
    await page.getByText("找不到引擎？检查 CLI 路径", { exact: true }).click();
    const row = f.panel.getByRole("region", { name: "Codex", exact: true });
    await row.getByRole("button", { name: "指定路径", exact: true }).click();
    let entered = () => {};
    const arrived = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    await page.route("**/api/settings/engines", async route => { if (route.request().method() === "PUT") { entered(); await gate; } await route.continue(); });
    await row.getByRole("button", { name: "保存路径", exact: true }).click();
    await arrived;
    await expect(create).toBeDisabled();
    release();
    await expect(f.panel.getByText("已保存并核实。", { exact: true })).toBeVisible();
    await page.getByText("找不到引擎？检查 CLI 路径", { exact: true }).click();
    await expect(create).toBeEnabled();
  } finally { release(); await f.dispose(); }
});

test("cancel after an uncertain save leaves a visible recovery action", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 }); const f = await fixture(page);
  try {
    const row = f.panel.getByRole("region", { name: "Codex", exact: true });
    await row.getByRole("button", { name: "指定路径", exact: true }).click();
    await row.getByLabel("Codex CLI 程序路径").fill(f.executable);
    await page.route("**/api/settings/engines", route => route.request().method() === "PUT" ? route.abort("failed") : route.continue());
    await row.getByRole("button", { name: "保存路径", exact: true }).click();
    await expect(row.getByRole("alert")).toContainText("保存结果未确认");
    await row.getByRole("button", { name: "取消", exact: true }).click();
    const recovery = f.panel.getByRole("button", { name: "重新读取", exact: true });
    await expect(recovery).toBeInViewport(); await expect(f.panel.getByRole("alert")).toBeInViewport();
    await recovery.click(); await expect(row.getByRole("button", { name: "指定路径", exact: true })).toBeEnabled();
  } finally { await f.dispose(); }
});
test("path editing keeps keyboard focus and blocks creating from an unsaved draft", async ({ page }) => {
  const f = await fixture(page, false);
  try {
    await f.hub.engineSettings.update({ engine: "codex", path: f.executable, requestId: "seed", revision: "default" }, apply => apply());
    await page.getByRole("button", { name: "新建", exact: true }).filter({ visible: true }).click();
    await page.getByRole("button", { name: "新建 Bot", exact: true }).or(page.getByRole("menuitem", { name: "新建 Bot", exact: true })).click();
    await page.getByLabel("Bot 名称", { exact: true }).fill("Example Bot");
    const create = page.getByRole("button", { name: "创建 Bot", exact: true }); await expect(create).toBeEnabled();
    await page.getByText("找不到引擎？检查 CLI 路径", { exact: true }).click();
    const row = f.panel.getByRole("region", { name: "Codex", exact: true }), edit = row.getByRole("button", { name: "指定路径", exact: true });
    await edit.focus(); await edit.press("Enter");
    const input = row.getByLabel("Codex CLI 程序路径"); await expect(input).toBeFocused();
    await input.fill(f.executable + "-draft"); await expect(create).toBeDisabled();
    await input.press("Escape"); await expect(edit).toBeFocused(); await expect(create).toBeEnabled();
    await page.getByText("找不到引擎？检查 CLI 路径", { exact: true }).click();
    await page.route("**/api/bots", route => route.request().method() === "POST" ? route.abort("failed") : route.continue());
    await create.click(); await expect(page.getByRole("button", { name: "重试创建", exact: true })).toBeEnabled();
    await page.getByText("找不到引擎？检查 CLI 路径", { exact: true }).click();
    await expect(edit).toBeDisabled();
  } finally { await f.dispose(); }
});
test("damaged host settings offer actionable recovery without silently changing paths", async ({ page }) => {
  const f = await fixture(page);
  try {
    await writeFile(path.join(f.root, "engine-settings.json"), "broken", { mode: 0o600 });
    await f.panel.getByRole("button", { name: "重新检测", exact: true }).click();
    await expect(f.panel.getByRole("alert")).toContainText("engine-settings.json");
    await expect(f.panel.getByRole("alert")).toContainText("不要直接删除文件");
    await writeFile(path.join(f.root, "engine-settings.json"), JSON.stringify({ format: 1, revision: "repaired", paths: {}, receipts: [] }));
    await f.panel.getByRole("button", { name: "重新读取", exact: true }).click();
    await expect(f.panel.getByRole("alert")).toHaveCount(0);
    await expect(f.panel.getByRole("region", { name: "Codex", exact: true })).toContainText("未检测到 CLI");
  } finally { await f.dispose(); }
});

test("revoking ownership clears the private path draft and its unsaved guard", async ({ page }) => {
  const f = await fixture(page);
  try {
    const row = f.panel.getByRole("region", { name: "Codex", exact: true });
    await row.getByRole("button", { name: "指定路径", exact: true }).click();
    await row.getByLabel("Codex CLI 程序路径").fill("   ");
    await expect(f.panel.getByRole("button", { name: "重新检测", exact: true })).toBeEnabled();
    await row.getByLabel("Codex CLI 程序路径").fill(f.executable);
    await expect(page.locator('.settings-unsaved-dot')).toHaveCount(1);
    await f.hub.store.db.run("UPDATE users SET role='member' WHERE id='owner'");
    for (const client of (f.hub as any).clients) client.ws.close();
    await expect(f.panel).toContainText("仅主机所有者可以查看和修改引擎路径。", { timeout: 15_000 });
    await expect(page.locator('.settings-unsaved-dot')).toHaveCount(0);
    await expect(f.panel.locator("input")).toHaveCount(0);
  } finally { await f.dispose(); }
});

test("a disappeared model is shown as unavailable without changing approval preferences", async ({ page }) => {
  const f = await fixture(page, false);
  try {
    await f.hub.engineSettings.update({ engine: "codex", path: f.executable, requestId: "seed", revision: "default" }, apply => apply());
    let missing = false;
    await page.route("**/api/bots/catalog", async route => {
      const response = await route.fetch(), body = await response.json();
      if (missing) for (const engine of body.engines) if (engine.id === "codex") engine.models = engine.models.filter((model: { id: string }) => model.id !== "gpt-6.1-sol");
      await route.fulfill({ response, json: body });
    });
    await page.getByRole("button", { name: "新建", exact: true }).filter({ visible: true }).click();
    await page.getByRole("button", { name: "新建 Bot", exact: true }).or(page.getByRole("menuitem", { name: "新建 Bot", exact: true })).click();
    await page.getByLabel("Bot 名称", { exact: true }).fill("Example Bot");
    const model = page.getByRole("combobox", { name: "模型", exact: true }), permission = page.getByRole("combobox", { name: "权限与批准", exact: true });
    await model.selectOption("gpt-6.1-sol"); await permission.selectOption("full-auto");
    await page.getByText("找不到引擎？检查 CLI 路径", { exact: true }).click();
    const row = f.panel.getByRole("region", { name: "Codex", exact: true });
    await row.getByRole("button", { name: "指定路径", exact: true }).click(); missing = true;
    await row.getByRole("button", { name: "保存路径", exact: true }).click();
    await expect(f.panel.getByText("已保存并核实。", { exact: true })).toBeVisible();
    await page.getByText("找不到引擎？检查 CLI 路径", { exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("此前选择的模型或推理强度已不可用");
    await expect(model).toHaveValue("gpt-6.1-sol"); await expect(permission).toHaveValue("full-auto");
    await expect(page.getByRole("button", { name: "创建 Bot", exact: true })).toBeDisabled();
    await model.selectOption("");
    await expect(page.getByRole("button", { name: "创建 Bot", exact: true })).toBeEnabled();
    await expect(permission).toHaveValue("full-auto");
  } finally { await f.dispose(); }
});
