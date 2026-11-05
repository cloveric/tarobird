import { test, expect, type Page } from "@playwright/test";
import { createServer } from "./fixtures/vite.js";
import type { ViteDevServer } from "vite";

let server: ViteDevServer, url: string;
test.beforeAll(async () => { server = await createServer({ server: { host: "127.0.0.1", port: 0 } }); await server.listen(); url = server.resolvedUrls!.local[0] + "e2e/fixtures/ticket-actions.html"; });
test.afterAll(async () => { await server.close(); });
async function open(page: Page, mode: string, english = false) {
  await page.goto(`${url}?mode=${mode}&lang=${english ? "en" : "zh"}`);
  await page.locator(".dispatch-tickets-trigger").click();
  await expect(page.getByText("Completed ticket", { exact: true })).toBeVisible();
}
async function remove(page: Page, english = false) {
  await page.getByRole("button", { name: english ? "Remove" : "移除", exact: true }).click();
  await page.getByRole("button", { name: english ? "Remove ticket" : "确认移除工单", exact: true }).click();
}
test("an older Host snapshot offers no unsupported ticket removal", async ({ page }) => {
  await open(page, "legacy");
  await expect(page.getByRole("button", { name: "移除", exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).ticketRequests)).toEqual([]);
});
for (const english of [false, true]) test(`a definite old-Host removal rejection requests a Host update (${english ? "en" : "zh"})`, async ({ page }) => {
  await open(page, "reject", english); await remove(page, english);
  await expect(page.getByRole("alert")).toHaveText(english ? "This host does not support removing tickets yet. Update the host and try again." : "此主机尚不支持移除工单，请更新主机后重试。");
  await expect(page.getByText("Completed ticket", { exact: true })).toBeVisible();
});
test("an uncertain removal retries with its original request ID and hides only a confirmed result", async ({ page }) => {
  await open(page, "uncertain"); await remove(page);
  await expect(page.getByRole("alert")).toHaveText("操作结果未确认，请稍后重试。");
  await expect(page.getByText("Completed ticket", { exact: true })).toBeVisible();
  await remove(page);
  await expect(page.getByText("Completed ticket", { exact: true })).toHaveCount(0);
  const requests = await page.evaluate(() => (window as any).ticketRequests);
  expect(requests).toHaveLength(2); expect(requests[1]).toEqual(requests[0]);
});
for (const mode of ["other-reject", "reject-pause"]) test(`other rejected actions do not misreport an unsupported removal (${mode})`, async ({ page }) => {
  await open(page, mode);
  if (mode === "reject-pause") await page.getByRole("button", { name: "暂停", exact: true }).click();
  else await remove(page);
  await expect(page.getByRole("alert")).toHaveText("操作结果未确认，请稍后重试。");
  await expect(page.getByText("Completed ticket", { exact: true })).toBeVisible();
});
