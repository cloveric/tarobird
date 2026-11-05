import { preparePairing } from "./fixtures/pairing-invite.js";
import { widgetPolicyFile } from "../../src/runtime/widget-policy.js";
import { test, expect, type Page } from "@playwright/test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { HubServer } from "../../src/hub/server.js";
import { waitForClientOnline, openWorkspacePage } from "./fixtures/mobile.js";

test.use({ serviceWorkers: "block" });
async function fixture(page: Page) {
  const root = await mkdtemp(path.join(os.tmpdir(), "widget-settings-ui-"));
  const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve("dist") });
  try {
    await hub.profile.update({ name: "Mac mini", revision: (await hub.profile.read()).revision });
    await page.goto(hub.url); await preparePairing(page, hub); await page.getByRole("button", { name: "配对此设备", exact: true }).click();
    await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
    await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" }); await waitForClientOnline(page);
    const open = async () => { await openWorkspacePage(page, "设置"); await page.getByRole("navigation", { name: "设置分类" }).getByRole("button", { name: /^通用/ }).click(); };
    await open();
    return { hub, root, open, panel: page.locator(".widget-settings"), dispose: async () => { await page.close(); await hub.close(); await rm(root, { recursive: true, force: true }); } };
  } catch (error) { await page.close(); await hub.close(); await rm(root, { recursive: true, force: true }); throw error; }
}
for (const width of [1360, 390]) test(`host switch persists, supports keyboard and both themes at ${width}px`, async ({ page }, info) => {
  await page.setViewportSize({ width, height: 1000 }); const f = await fixture(page);
  try {
    const toggle = f.panel.getByRole("switch"); await expect(toggle).toBeChecked();
    await expect(toggle).toHaveAccessibleDescription("用图表、时间线直观展示信息。");
    await toggle.focus(); await toggle.press("Space"); await expect(f.panel.getByText("已保存并核实。", { exact: true })).toBeVisible();
    await expect(toggle).not.toBeChecked(); expect(f.hub.widgetSettings.status().enabled).toBe(false);
    await f.panel.scrollIntoViewIfNeeded(); await page.screenshot({ path: info.outputPath(`widget-settings-light-zh-${width}.png`) });
    await page.reload(); await waitForClientOnline(page); await f.open(); await expect(toggle).not.toBeChecked();
    await page.locator("#theme").selectOption("dark"); await page.locator("#language").selectOption("en");
    await f.panel.scrollIntoViewIfNeeded();
    await expect(toggle).toHaveAccessibleDescription("Off. Existing visuals remain available.");
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
    await page.screenshot({ path: info.outputPath(`widget-settings-dark-en-${width}.png`) });
    await toggle.click(); await expect(f.panel.getByText("Saved and verified.", { exact: true })).toBeVisible();
    await expect(toggle).toHaveAccessibleDescription("Explain information with charts and timelines.");
    expect(f.hub.widgetSettings.status().enabled).toBe(true);
  } finally { await f.dispose(); }
});
test("stale and unknown write outcomes require read-back without a second mutation", async ({ page }) => {
  const f = await fixture(page);
  try {
    const toggle = f.panel.getByRole("switch"); await expect(toggle).toBeChecked();
    await f.hub.widgetSettings.update({ requestId: "other-device", revision: "default", enabled: false }, async apply => apply());
    await toggle.click(); await expect(f.panel.getByRole("alert")).toBeVisible(); await expect(toggle).toBeDisabled();
    await f.panel.getByRole("button", { name: "重新读取", exact: true }).click(); await expect(toggle).toBeEnabled(); await expect(toggle).not.toBeChecked();
    let writes = 0;
    await page.route("**/api/settings/widgets", async route => {
      if (route.request().method() !== "PUT") return route.continue();
      writes++; await route.fetch(); await route.abort("failed");
    });
    await toggle.click(); await expect(f.panel.getByRole("alert")).toBeVisible();
    expect(f.hub.widgetSettings.status().enabled).toBe(true); expect(writes).toBe(1);
    await f.panel.getByRole("button", { name: "重新读取", exact: true }).click(); await expect(toggle).toBeChecked(); await expect(toggle).toBeEnabled(); expect(writes).toBe(1);
  } finally { await f.dispose(); }
});

test("damaged settings recover to off and members see a permission explanation", async ({ page }) => {
  const f = await fixture(page);
  try {
    await writeFile(widgetPolicyFile(f.root), "{broken", { mode: 0o600 });
    await page.reload(); await waitForClientOnline(page); await f.open();
    await expect(f.panel.getByRole("switch")).toBeDisabled();
    await f.panel.getByRole("button", { name: "恢复为关闭状态", exact: true }).click();
    await expect(f.panel.getByText("已保存并核实。", { exact: true })).toBeVisible();
    await expect(f.panel.getByRole("switch")).not.toBeChecked(); await expect(f.panel.getByRole("switch")).toBeEnabled();
    await f.hub.store.db.run("UPDATE users SET role='member' WHERE id='owner'");
    let requests = 0; await page.route("**/api/settings/widgets*", route => { requests++; return route.continue(); });
    await page.reload(); await waitForClientOnline(page); await f.open();
    await expect(f.panel).toContainText("仅主机所有者可以配置可视化回复。");
    await expect(f.panel.getByRole("alert")).toHaveCount(0); expect(requests).toBe(0);
  } finally { await f.dispose(); }
});
