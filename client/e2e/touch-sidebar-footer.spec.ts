import { test, expect, type Page } from "@playwright/test";
import { imageViewerFixture } from "./fixtures/image-viewer.js";

// Browsers report zero env() insets. Substitute only that input (as the iOS
// layout suite does) so the touch layout sees an iPhone-like 34px home
// indicator. Browser evidence, not an installed App on a device.
async function insets(page: Page) {
  await page.route("**/*.css", async route => {
    const response = await route.fetch();
    const css = (await response.text()).replace(/env\(safe-area-inset-(top|right|bottom|left)(?:,[^)]*)?\)/g, "var(--fixture-safe-$1, 0px)");
    await route.fulfill({ response, body: css });
  });
}
const footer = (page: Page) => page.locator(".host-workspace:not([hidden]) .sidebar > .sidebar-footer");
const geometry = (page: Page) => page.evaluate(() => {
  const sidebar = document.querySelector(".host-workspace:not([hidden]) .sidebar") as HTMLElement, foot = sidebar.querySelector(":scope > .sidebar-footer") as HTMLElement;
  const box = foot.getBoundingClientRect(), controls = [...foot.querySelectorAll("button")].map(button => button.getBoundingClientRect().bottom);
  return { inner: innerHeight, top: box.top, bottom: box.bottom, height: box.height, footerPad: parseFloat(getComputedStyle(foot).paddingBottom), sidebarPad: parseFloat(getComputedStyle(sidebar).paddingBottom), controls: Math.max(...controls) };
});

test.describe("touch layout with a home indicator", () => {
  test.use({ viewport: { width: 910, height: 640 }, hasTouch: true });
  test("the sidebar footer reaches the bottom edge and keeps its controls above the inset", async ({ page }, info) => {
    await insets(page);
    const f = await imageViewerFixture(page);
    try {
      await page.evaluate(() => document.documentElement.style.setProperty("--fixture-safe-bottom", "34px"));
      await expect(footer(page)).toBeVisible();
      const g = await geometry(page);
      expect(g.bottom).toBe(g.inner);
      expect(g.sidebarPad).toBe(0);
      expect(g.footerPad).toBe(34);
      expect(g.height).toBe(56 + 34);
      expect(g.controls).toBeLessThanOrEqual(g.inner - 34);
      await page.mouse.move(0, 0); await page.screenshot({ path: info.outputPath("touch-footer.png") });
      // No inset (e.g. Android native insets): the footer is the ordinary 56px row.
      await page.evaluate(() => document.documentElement.style.setProperty("--fixture-safe-bottom", "0px"));
      await expect.poll(async () => (await geometry(page)).height).toBe(56);
      expect((await geometry(page)).bottom).toBe((await geometry(page)).inner);
    } finally { await page.close(); await f.close(); }
  });
});

test("desktop pointer layout keeps the 56px footer at the bottom", async ({ page }) => {
  await page.setViewportSize({ width: 1360, height: 860 });
  const f = await imageViewerFixture(page);
  try {
    await expect(footer(page)).toBeVisible();
    const g = await geometry(page);
    expect(g.height).toBe(56); expect(g.footerPad).toBe(0); expect(g.bottom).toBe(g.inner);
  } finally { await page.close(); await f.close(); }
});
