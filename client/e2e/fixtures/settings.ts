import { expect, type Page } from "@playwright/test";
import { openWorkspacePage } from "./mobile.js";
import type { ColorPalette } from "../../src/palettes.js";

/** User-facing category navigation, shared by desktop and phone journeys. */
export async function openSettings(page: Page, section: "general" | "connection" | "devices" | "notifications" = "general") {
  if (section === "connection") { await openWorkspacePage(page, "连接状态与线路"); await page.getByRole("button", { name: "编辑线路", exact: true }).click(); return; }
  await openWorkspacePage(page, "设置");
  const names = { general: /^通用/, connection: /^连接/, devices: /^设备与安全/, notifications: /^通知/ };
  await page.getByRole("navigation", { name: "设置分类" }).getByRole("button", { name: names[section] }).click();
}

/** Exercise supported themes through the visible picker. */
export async function selectPaletteForCoverage(page: Page, palette: ColorPalette) {
  const input = page.locator(`input[name="color-palette"][value="${palette}"]`);
  await input.check(); await expect(input).toBeChecked();
}

/** Close the actual page stack, leaving a discard confirmation open if needed. */
export async function closeSettings(page: Page, english = false) {
  const connectionClose = page.getByRole("button", { name: english ? "Close connection status & routes" : "关闭连接状态与线路", exact: true });
  if (await connectionClose.isVisible()) { await connectionClose.click(); return; }
  const back = page.getByRole("button", { name: english ? "Back to settings categories" : "返回设置分类", exact: true });
  if (await back.isVisible()) await back.click();
  await page.getByRole("button", { name: english ? "Close settings" : "关闭设置", exact: true }).click();
}

/** Enter the dedicated pairing flow; step 0 shares the host, step 1 approves. */
export async function openDevicePairing(page: Page, english = false, step = 1) {
  await page.getByRole("button", { name: english ? "Add device" : "添加设备", exact: true }).click();
  if (step > 0) await page.getByRole("dialog", { name: english ? "Add device" : "添加设备", exact: true }).getByRole("button", { name: english ? "Scanned — enter pairing code" : "已扫码，输入配对码", exact: true }).click();
}
export async function closeDevicePairing(page: Page, english = false) {
  await page.getByRole("button", { name: english ? "Close device pairing" : "关闭添加设备", exact: true }).click();
}

/** Quiet hours are a secondary row; open it before editing its retained draft. */
export async function openQuietHours(page: Page) {
  const details = page.locator("details.notification-quiet");
  await expect(details).toBeVisible();
  if (!await details.evaluate(element => (element as HTMLDetailsElement).open)) await details.locator("summary").click();
}
