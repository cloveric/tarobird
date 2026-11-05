import { expect, test } from "@playwright/test";
import { createServer } from "./fixtures/vite.js";

// Characterization, not a native-phone benchmark. Keep tracing off so DOM
// snapshots do not become part of the application's measured work.
test.use({ trace: "off" });
for (const scenario of ["code-blocks", "throttled-prose"] as const) test(`large Markdown remains complete: ${scenario}`, async ({ page, browserName }, info) => {
  test.skip(browserName !== "chromium", "CPU throttling and long-task observations require Chromium");
  test.setTimeout(90_000);
  const server = await createServer({ server: { port: 0, host: "127.0.0.1" } }); await server.listen();
  const session = await page.context().newCDPSession(page);
  try {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(server.resolvedUrls!.local[0] + "e2e/fixtures/markdown.html");
    await expect(page.locator(".markdown p")).toHaveText("start");
    const rate = scenario === "throttled-prose" ? 4 : 1;
    await session.send("Emulation.setCPUThrottlingRate", { rate });
    const expected = scenario === "code-blocks"
      ? Array.from({ length: 300 }, (_, i) => Array.from({ length: 25 }, (_, j) => `const item_${i}_${j} = { name: "sample", value: ${i + j} };`).join("\n") + "\n")
      : Array.from({ length: 20_000 }, (_, i) => `PARAGRAPH_${i}`);
    const text = (scenario === "code-blocks" ? expected.map(code => "```typescript\n" + code + "```\n\n") : expected).join(scenario === "code-blocks" ? "" : "\n\n") + "\n\nVOLUME_DONE";
    await page.evaluate(text => {
      const tasks: number[] = [], started = performance.now();
      const observer = new PerformanceObserver(list => tasks.push(...list.getEntries().map(entry => entry.duration)));
      observer.observe({ type: "longtask", buffered: false });
      Object.assign(window, { finishVolume: () => { observer.disconnect(); return { completeMs: performance.now() - started, longestTask: Math.max(0, ...tasks), longTaskCount: tasks.length }; } });
      (window as any).setMarkdown(text);
    }, text);
    await page.waitForFunction(() => document.querySelector(".markdown-chunk:last-child > p:last-child")?.textContent === "VOLUME_DONE", undefined, { timeout: 60_000 });
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    const report = { scenario, cpuRate: rate, ...await page.evaluate(() => (window as any).finishVolume()) };
    console.log("Markdown volume", JSON.stringify(report));
    await info.attach("volume-characterization", { body: JSON.stringify(report, null, 2), contentType: "application/json" });
    await session.send("Emulation.setCPUThrottlingRate", { rate: 1 });
    if (scenario === "code-blocks") {
      expect(await page.locator(".markdown pre code").allTextContents()).toEqual(expected);
      expect(await page.locator(".markdown pre code span").count()).toBeGreaterThan(300);
    } else expect((await page.locator(".markdown p").allTextContents()).slice(0, -1)).toEqual(expected);
    await expect(page.getByRole("button", { name: "恢复排版", exact: true })).toHaveCount(0);
  } finally { await session.detach(); await page.close(); await server.close(); }
});
