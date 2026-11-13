import { test, expect } from "@playwright/test";
import { createServer } from "./fixtures/vite.js";
import type { ViteDevServer } from "vite";

let server: ViteDevServer;
test.beforeAll(async () => { server = await createServer({ server: { host: "127.0.0.1", port: 0 } }); await server.listen(); });
test.afterAll(async () => { await server?.close(); });
for (const scope of [
  { name: "iOS ordinary phone", platform: "ios", width: 390, height: 844 },
  { name: "iOS expanded phone", platform: "ios", width: 951, height: 669 },
  { name: "iOS tablet", platform: "ios", width: 1024, height: 1366 },
  { name: "Android phone", platform: "android", width: 390, height: 844 },
  { name: "desktop", platform: "web", width: 1360, height: 900 },
]) for (const format of ["canvas", "slides"] as const) test(`${scope.name} ${format} repair actions respect the platform while errors remain readable`, async ({ page }) => {
  await page.setViewportSize({ width: scope.width, height: scope.height });
  await page.goto(`${server.resolvedUrls!.local[0]}e2e/fixtures/design-repair-platform.html?platform=${scope.platform}&format=${format}`);
  const editor = page.frameLocator(".workbench-design-frame");
  const notice = editor.locator(format === "canvas" ? '[data-testid^="mega-artboard-notice-"]:not([data-testid*="-ask-"]):not([data-testid*="-dismiss-"]):not([data-testid*="-sign-"])' : '[data-testid="slides-held-notice"]');
  await expect(notice).toBeVisible({ timeout: 30000 });
  const repair = editor.getByRole("button", { name: "Ask the agent to fix", exact: true });
  if (scope.platform === "ios") {
    await expect(repair).toHaveCount(0);
    if (format === "canvas") {
      await editor.getByRole("button", { name: "Show all artboards with errors", exact: true }).click();
      await expect(editor.getByTestId("design-problems-list")).toContainText("PLATFORM_REPAIR_FIXTURE");
      await expect(editor.getByTestId("design-problems-ask")).toHaveCount(0);
    }
    await expect(editor.locator("body")).not.toContainText(/can ask the agent|Ask the agent to fix/);
    const refusal = await editor.locator("body").evaluate(async () => {
      try { await (window as any).__tarobotDesignSuggest("Repair fixture"); return "accepted"; }
      catch (error) { return error instanceof Error ? error.message : String(error); }
    });
    expect(refusal).toBe("design_repair_unavailable");
    await expect(page.getByRole("textbox", { name: "Draft" })).toHaveValue("Keep my draft.");
    expect(await page.evaluate(() => (window as any).repairPlatform.drafts)).toBe(0);
  } else {
    await expect(repair).toBeVisible(); await repair.click();
    await expect(page.getByRole("textbox", { name: "Draft" })).toHaveValue(/Keep my draft\.[\s\S]*Platform review/);
    expect(await page.evaluate(() => (window as any).repairPlatform.drafts)).toBe(1);
  }
  expect(await page.evaluate(async () => (await (window as any).repairPlatform.restore()).status)).toBe(200);
});

for (const platform of ["ios", "web"]) test(`${platform} damaged canvas index keeps error details and the intended repair capability`, async ({ page }) => {
  await page.goto(`${server.resolvedUrls!.local[0]}e2e/fixtures/design-repair-platform.html?platform=${platform}&format=canvas&index=1`);
  const editor = page.frameLocator(".workbench-design-frame");
  await expect(editor.locator("body")).toContainText(/saved layout has a problem/i, { timeout: 30000 });
  const ask = editor.getByRole("button", { name: "Ask the agent to fix", exact: true });
  if (platform === "ios") {
    await expect(ask).toHaveCount(0);
    await expect(editor.locator("body")).not.toContainText(/can ask the agent|Ask the agent to fix/);
  }
  else await expect(ask).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Draft" })).toHaveValue("Keep my draft.");
});
