import { expect, test } from "@playwright/test";
import { mobileContentServer } from "./fixtures/mobile-content-server.js";

test("mobile bundle policy preserves worker formatting/local media and blocks passive external traffic", async ({ page }) => {
  const server = await mobileContentServer();
  try {
    await page.goto(server.url);
    await expect(page.getByRole("link", { name: /外部图表/ })).toHaveAttribute("rel", "noopener noreferrer");
    await expect(page.locator(".markdown img")).toHaveCount(0);
    await expect(page.locator(".katex")).toHaveCount(1);
    await expect(page.locator(".hljs")).toHaveCount(1);
    await expect.poll(() => page.getByRole("img", { name: "Allowed local preview" }).evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(1);
    await page.getByRole("button", { name: "Try external image" }).click();
    await expect(page.getByLabel("Policy events")).toContainText("img-src");
    await page.getByRole("button", { name: "Try external request" }).click();
    await expect(page.getByLabel("Request result")).toHaveText("Request blocked");
    await expect(page.getByLabel("Policy events")).toContainText("connect-src");
    expect(server.requests()).toBe(0);
  } finally { await server.close(); }
});
