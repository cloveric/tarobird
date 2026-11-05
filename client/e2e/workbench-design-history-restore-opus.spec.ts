import { test, expect } from "@playwright/test";
import type { ViteDevServer } from "vite";
import { createServer } from "./fixtures/vite.js";

// Opus CC1: the production history panel must keep a failed restore visible
// after it refreshes the list; a failed refresh is shown separately.
let server: ViteDevServer;
test.beforeAll(async () => { server = await createServer({ server: { host: "127.0.0.1", port: 0 } }); await server.listen(); });
test.afterAll(async () => server?.close());
test.use({ serviceWorkers: "block" });
const open = async (page: import("@playwright/test").Page) => {
  await page.goto(server.resolvedUrls!.local[0] + "e2e/fixtures/design-history-restore-opus.html");
  await page.getByRole("button", { name: "历史", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "版本历史", exact: true }); await expect(dialog.getByText(/^#1 · /)).toBeVisible();
  return dialog;
};
const restoreOldest = async (dialog: import("@playwright/test").Locator) => {
  await dialog.getByRole("button", { name: "恢复整版", exact: true }).click();
  await dialog.getByRole("alertdialog", { name: "确认恢复", exact: true }).getByRole("button", { name: "恢复", exact: true }).click();
};

test("opus: a failed restore stays visible after the history list refreshes", async ({ page }) => {
  const dialog = await open(page);
  await restoreOldest(dialog);
  await expect.poll(() => page.evaluate(() => (window as any).historyFixture.lists)).toBe(2);
  await expect(dialog.getByRole("alert")).toContainText("刚被修改");
  await page.waitForTimeout(300);
  await expect(dialog.getByRole("alert")).toContainText("刚被修改");
  expect(await page.evaluate(() => (window as any).historyFixture.restored)).toBe(0);
  // Browsing afterwards does not hide it; closing the panel clears it.
  await dialog.getByRole("button", { name: "改动", exact: true }).first().click(); await dialog.getByRole("button", { name: "返回", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("刚被修改");
  await dialog.getByRole("button", { name: "关闭", exact: true }).click();
  await page.getByRole("button", { name: "历史", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "版本历史", exact: true }).getByText(/^#1 · /)).toBeVisible();
  await expect(page.getByRole("dialog", { name: "版本历史", exact: true }).getByRole("alert")).toHaveCount(0);
});

test("opus: when the refresh after a failed restore also fails, both errors are shown", async ({ page }) => {
  const dialog = await open(page);
  await page.evaluate(() => { (window as any).historyFixture.failList = true; });
  await restoreOldest(dialog);
  await expect.poll(() => page.evaluate(() => (window as any).historyFixture.lists)).toBe(2);
  await expect(dialog.getByRole("alert").filter({ hasText: "刚被修改" })).toHaveCount(1);
  await expect(dialog.getByRole("alert").filter({ hasText: "无法读取历史" })).toHaveCount(1);
});

test("opus: a successful restore refreshes without an error", async ({ page }) => {
  const dialog = await open(page);
  await page.evaluate(() => { (window as any).historyFixture.failRestore = ""; });
  await restoreOldest(dialog);
  await expect.poll(() => page.evaluate(() => (window as any).historyFixture.restored)).toBe(1);
  await expect.poll(() => page.evaluate(() => (window as any).historyFixture.lists)).toBe(2);
  await expect(dialog.getByRole("alert")).toHaveCount(0);
});
