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
  const box = foot.getBoundingClientRect();
  return { inner: innerHeight, top: box.top, bottom: box.bottom, height: box.height, footerPad: parseFloat(getComputedStyle(foot).paddingBottom), sidebarPad: parseFloat(getComputedStyle(sidebar).paddingBottom) };
});

test.describe("touch layout with a home indicator", () => {
  test.use({ viewport: { width: 910, height: 640 }, hasTouch: true });
  test("the 56px sidebar footer sits flush with the bottom edge, as on the desktop", async ({ page }, info) => {
    await insets(page);
    const f = await imageViewerFixture(page);
    try {
      await page.evaluate(() => document.documentElement.style.setProperty("--fixture-safe-bottom", "34px"));
      await expect(footer(page)).toBeVisible();
      const g = await geometry(page);
      expect(g.bottom).toBe(g.inner);
      expect(g.sidebarPad).toBe(0);
      expect(g.footerPad).toBe(0);
      expect(g.height).toBe(56);
      // The home indicator is centred; the footer's controls stay in the left sidebar, clear of it.
      expect(await footer(page).evaluate(node => node.getBoundingClientRect().right)).toBeLessThan(910 / 2 - 70);
      await page.mouse.move(0, 0); await page.screenshot({ path: info.outputPath("touch-footer.png") });
      // No inset (e.g. Android native insets): unchanged.
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
