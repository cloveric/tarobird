import { test, expect } from "@playwright/test";
import { createServer } from "./fixtures/vite.js";
let server: Awaited<ReturnType<typeof createServer>>, base: string;
test.beforeAll(async () => { server = await createServer({ server: { port: 0, host: "127.0.0.1" } }); await server.listen(); base = server.resolvedUrls!.local[0]!; });
test.afterAll(async () => { await server?.close(); });
for (const locale of ["zh", "en"]) for (const theme of ["light", "cli"]) test(`queue notice stays legible in a narrow pane: ${locale}/${theme}`, async ({ page }) => {
  await page.goto(`${base}e2e/fixtures/queue-notice.html?locale=${locale}&theme=${theme}&width=240`);
  const notice = page.locator(".queue-notice"); await expect(notice).toBeVisible();
  if (theme === "cli") await expect(notice).toHaveCSS("border-radius", "2px");
  expect(await notice.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  await expect(notice.locator(".run-stop,.run-process-trigger,.spin")).toHaveCount(0);
  await notice.getByRole("button").dblclick();
  expect(await page.evaluate(() => (window as any).queueFixture.actions)).toHaveLength(1);
  await page.evaluate(() => (window as any).queueFixture.publish("cancelled"));
  await expect(notice.getByRole("button")).toHaveCount(0);
});
test("a missing cancellation confirmation never implies success; offline controls do not send", async ({ page }) => {
  await page.clock.install(); await page.goto(`${base}e2e/fixtures/queue-notice.html`);
  const notice = page.locator(".queue-notice"), button = notice.getByRole("button");
  await button.click(); await page.clock.fastForward(8001);
  await expect(notice.getByRole("alert")).toContainText("尚未收到取消确认");
  await expect(notice.getByRole("alert")).toHaveCSS("color", "rgb(193, 53, 59)");
  await expect(notice).not.toContainText("已取消排队");
  await page.evaluate(() => (window as any).queueFixture.offline(true));
  await expect(button).toHaveAttribute("aria-disabled", "true");
  await button.dispatchEvent("click");
  expect(await page.evaluate(() => (window as any).queueFixture.actions)).toHaveLength(1);
  await expect(notice).toContainText("当前状态待确认");
});
test("legacy notices and terminal recovery remain native-looking with no active controls", async ({ page }) => {
  await page.goto(`${base}e2e/fixtures/queue-notice.html?legacy=1`);
  await expect(page.locator(".queue-notice")).toContainText("等待执行");
  await page.goto(`${base}e2e/fixtures/queue-notice.html?phase=started`);
  await expect(page.locator(".queue-notice")).toContainText("准备中");
  await expect(page.locator(".queue-notice button")).toHaveCount(0);
  await page.evaluate(() => (window as any).queueFixture.publish("expired", "error"));
  await expect(page.locator(".queue-notice")).toContainText("实际结果请查看对话中的后续回复");
  await expect(page.locator(".queue-notice button")).toHaveCount(0);
});
