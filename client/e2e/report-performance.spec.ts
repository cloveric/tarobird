import { test, expect } from "@playwright/test";
import { createServer } from "./fixtures/vite.js";

test.use({ trace: "off", serviceWorkers: "block" });
for (const width of [1360, 390]) test(`maximum report remains readable and filters at ${width}px`, async ({ page }, info) => {
  await page.setViewportSize({ width, height: 900 });
  const server = await createServer({ server: { port: 0, host: "127.0.0.1" } });
  await server.listen();
  try {
    await page.goto(server.resolvedUrls!.local[0]! + "e2e/fixtures/report-performance.html");
    await page.waitForFunction(() => !!(window as any).reportPerformance);
    const samples = await page.evaluate(() => {
      const fixture = (window as any).reportPerformance;
      fixture.mount(); fixture.unmount();
      return Array.from({ length: 7 }, () => {
        const start = performance.now(); fixture.mount();
        const elapsed = performance.now() - start;
        fixture.unmount(); return elapsed;
      });
    });
    await info.attach("report-render-ms", { body: JSON.stringify({ width, samples }), contentType: "application/json" });
    console.log("Report render ms", JSON.stringify({ width, samples }));
    await page.evaluate(() => (window as any).reportPerformance.mount());
    const report = page.locator(".inline-report");
    await expect(report.locator("tbody tr")).toHaveCount(200);
    await expect(report.locator("tbody tr").first().locator("td").nth(1)).toHaveText("-100");
    await expect(report.locator("tbody tr").first().locator("td").nth(2)).toHaveText("-99.86");
    await report.getByRole("searchbox").fill("记录 199");
    await expect(report.locator("tbody tr")).toHaveCount(1);
    await report.getByRole("searchbox").fill("");
    await expect(report.locator("tbody tr")).toHaveCount(200);
    await page.evaluate(() => (window as any).reportPerformance.unmount());
    await expect(page.locator("dialog")).toHaveCount(0);
  } finally { await page.close(); await server.close(); }
});
