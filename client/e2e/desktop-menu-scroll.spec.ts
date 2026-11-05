import { test, expect } from "@playwright/test";
import { createServer } from "./fixtures/vite.js";

for (const kind of ["anchored", "context"]) test(`a ${kind} sidebar menu survives unrelated chat scrolling but closes when its own anchor moves`, async ({ page }) => {
  const server = await createServer({ server: { port: 0, host: "127.0.0.1" } }); await server.listen();
  try {
    await page.goto(server.resolvedUrls!.local[0] + "e2e/fixtures/menu-scroll.html");
    if (kind === "anchored") await page.getByRole("button", { name: "列表选项", exact: true }).click();
    else await page.getByRole("button", { name: "Context heading", exact: true }).click({ button: "right" });
    const menu = page.locator(".desktop-menu");
    await expect(menu).toBeVisible();
    const chat = page.getByLabel("Chat scroll", { exact: true });
    await chat.hover(); await page.mouse.wheel(0, 120);
    await expect.poll(() => chat.evaluate(node => node.scrollTop)).toBeGreaterThan(0);
    await expect(menu).toBeVisible(); await menu.getByRole("button", { name: "Keep open" }).click();
    await expect(menu).toBeVisible();
    const sidebar = page.getByLabel("Sidebar scroll", { exact: true });
    await sidebar.hover(); await page.mouse.wheel(0, 120);
    await expect.poll(() => sidebar.evaluate(node => node.scrollTop)).toBeGreaterThan(0);
    await expect(menu).toHaveCount(0);
  } finally { await page.close(); await server.close(); }
});
