import { test, expect, type Page } from "@playwright/test";
import { createServer } from "./fixtures/vite.js";

test.use({ hasTouch: true });
const pageErrors = new WeakMap<Page, string[]>();
test.beforeEach(({ page }) => { const errors: string[] = []; pageErrors.set(page, errors); page.on("pageerror", error => errors.push(error.message)); });
test.afterEach(({ page }) => { expect(pageErrors.get(page)).toEqual([]); });

let server: Awaited<ReturnType<typeof createServer>>, base: string;
test.beforeAll(async () => {
  server = await createServer({ server: { port: 0, strictPort: false, host: "127.0.0.1" } }); await server.listen();
  base = server.resolvedUrls!.local[0] + "e2e/fixtures/pairing-design.html";
});
test.afterAll(async () => { await server?.close(); });

async function fits(page: Page) {
  const clipped = await page.locator(".pairing-page").evaluate(element => {
    const outer = element.getBoundingClientRect();
    return [...element.querySelectorAll("h1, p, button, input, summary, .wordmark")].filter(node => {
      const rect = node.getBoundingClientRect();
      return rect.width > 0 && (rect.left < outer.left - 1 || rect.right > outer.right + 1);
    }).map(node => node.tagName);
  });
  expect(clipped).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
}

const phones = [
  { name: "compact", os: "ios", width: 320, height: 568, safe: 20 },
  { name: "home-button", os: "ios", width: 375, height: 667, safe: 20 },
  { name: "notch", os: "ios", width: 390, height: 844, safe: 59 },
  { name: "large", os: "ios", width: 440, height: 956, safe: 62 },
  { name: "small-android", os: "android", width: 360, height: 800, safe: 0 },
  { name: "large-android", os: "android", width: 412, height: 915, safe: 0 },
  { name: "fold-cover", os: "android", width: 344, height: 882, safe: 0 },
  { name: "fold-open", os: "android", width: 673, height: 841, safe: 0 },
];
for (const phone of phones) for (const lang of ["zh", "en"]) test(`phone welcome ${phone.name} ${lang} stays usable`, async ({ page }) => {
  await page.setViewportSize({ width: phone.width, height: phone.height });
  await page.goto(`${base}?view=phone&os=${phone.os}&lang=${lang}`);
  await page.locator(".pairing-card h1").waitFor();
  await page.evaluate(({ safe }) => {
    document.documentElement.style.setProperty("--app-safe-top", `${safe}px`);
    document.documentElement.style.setProperty("--app-safe-bottom", safe > 20 ? "34px" : "0px");
  }, phone);
  const mark = page.locator(".pairing-card>.wordmark");
  await expect(mark.locator(".wordmark-text")).toBeHidden();
  const logo = (await mark.locator("img").boundingBox())!, heading = (await page.locator(".pairing-card h1").boundingBox())!;
  expect(logo.width).toBe(128); expect(logo.y).toBeGreaterThanOrEqual(phone.safe);
  expect(Math.abs(logo.x + logo.width / 2 - heading.x - heading.width / 2)).toBeLessThan(1);
  expect(heading.y - logo.y - logo.height).toBeLessThanOrEqual(16);
  await fits(page);
  const paste = page.locator(".pairing-import-actions button").first();
  await paste.click();
  const dialog = page.getByRole("dialog"); await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape"); await expect(dialog).toHaveCount(0);
  const manual = page.locator(".pairing-manual"); await manual.click();
  const address = page.locator('input[type="url"]'); await expect(address).toBeVisible();
  await address.fill("https://example.test");
  // Rotation and a keyboard-sized viewport must keep entered fields reachable.
  await page.setViewportSize({ width: phone.height, height: Math.max(240, Math.floor(phone.width * .7)) });
  await address.scrollIntoViewIfNeeded(); await expect(address).toBeInViewport(); await expect(address).toHaveValue("https://example.test");
  await fits(page);
});

for (const os of ["ios", "android"]) test(`landscape ${os} leaves the top and final instructions reachable`, async ({ page }) => {
  await page.setViewportSize({ width: 852, height: 393 });
  await page.goto(`${base}?view=phone&os=${os}&lang=en`);
  await page.locator(".pairing-card h1").waitFor();
  await page.evaluate(() => {
    document.documentElement.style.setProperty("--app-safe-left", "59px");
    document.documentElement.style.setProperty("--app-safe-right", "24px");
    document.documentElement.style.setProperty("--app-safe-bottom", "21px");
  });
  const first = (await page.locator(".pairing-card>.wordmark").boundingBox())!;
  expect(first.y).toBeGreaterThanOrEqual(0);
  const last = page.locator(".pairing-steps li").last();
  await last.scrollIntoViewIfNeeded(); await expect(last).toBeInViewport();
  await page.locator(".pairing-page").evaluate(element => { element.scrollTop = 0; });
  await expect(page.locator(".pairing-card>.wordmark")).toBeInViewport();
  await fits(page);
});

for (const os of ["ios", "android"]) test(`200 percent text, dark theme and pending confirmation ${os}`, async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await page.goto(`${base}?view=phone&os=${os}&lang=en&theme=dark`);
  await page.locator(".pairing-card h1").waitFor();
  // Synthetic text scaling exercises fixed-width controls; it is not OS Dynamic Type acceptance.
  await page.evaluate(() => {
    const sizes = [...document.querySelectorAll<HTMLElement>(".pairing-page *")].map(node => ({ node, font: parseFloat(getComputedStyle(node).fontSize), line: parseFloat(getComputedStyle(node).lineHeight) }));
    for (const { node, font, line } of sizes) { node.style.fontSize = `${font * 2}px`; if (Number.isFinite(line)) node.style.lineHeight = `${line * 2}px`; }
  });
  await fits(page);
  for (const button of await page.locator(".pairing-import-actions button").all()) {
    await button.scrollIntoViewIfNeeded(); await expect(button).toBeInViewport();
    expect(await button.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  }
  await page.goto(`${base}?view=phone&os=${os}&pending=1`);
  await expect(page.getByLabel("配对码", { exact: true })).toHaveText("12345678");
  await expect(page.locator(".wordmark-text")).toBeVisible();
  expect((await page.locator(".wordmark img").boundingBox())!.width).toBe(64);
  await fits(page);
});

for (const platform of ["macos", "windows"]) test(`desktop ${platform} keeps the bottom aligned name at narrow and wide widths`, async ({ page }) => {
  for (const width of [390, 1180]) {
    await page.setViewportSize({ width, height: 880 });
    await page.goto(`${base}?platform=${platform}`);
    const logo = page.locator(".desktop-welcome .wordmark img"), name = page.locator(".desktop-welcome .wordmark-text");
    await expect(name).toBeVisible();
    const a = (await logo.boundingBox())!, b = (await name.boundingBox())!;
    expect(a.width).toBe(64); expect(Math.abs(a.y + a.height - b.y - b.height)).toBeLessThan(1);
    await fits(page);
  }
});
