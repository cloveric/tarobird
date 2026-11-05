import { test, expect } from "@playwright/test";
import type { ViteDevServer } from "vite";
import { createServer } from "./fixtures/vite.js";

let server: ViteDevServer;
test.beforeAll(async () => { server = await createServer({ server: { host: "127.0.0.1", port: 0 } }); await server.listen(); });
test.afterAll(async () => { await server?.close(); });

for (const size of [{ name: "phone", width: 390, height: 844 }, { name: "landscape", width: 844, height: 390 }, { name: "desktop", width: 1360, height: 900 }]) {
  test(`${size.name}: long native task list scrolls to the final task without scrolling the page`, async ({ browser, browserName }, info) => {
    const phone = size.name !== "desktop";
    // Playwright cannot send wheel/touch-move input to mobile WebKit. Check its
    // narrow/coarse layout with wheel input; Chromium below supplies real touch.
    const context = await browser.newContext({ viewport: { width: size.width, height: size.height }, isMobile: phone && browserName === "chromium", hasTouch: phone });
    const page = await context.newPage();
    try {
      await page.goto(server.resolvedUrls!.local[0] + "e2e/fixtures/engine-tasks.html?count=12");
      await page.getByRole("button", { name: "子代理与后台任务", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: "子代理与后台任务", exact: true });
      await expect(dialog.getByRole("article")).toHaveCount(12);
      await page.evaluate(() => document.fonts.ready);
      const first = dialog.getByRole("article").first(), last = dialog.getByRole("article").last();
      await page.screenshot({ path: info.outputPath("tasks-before-scroll.png"), animations: "disabled" });
      const before = await first.boundingBox();
      await info.attach("scroll-geometry", { contentType: "application/json", body: JSON.stringify(await dialog.evaluate(node => [node, node.querySelector(".engine-tasks-list")!].map(element => ({ className: element.className, clientHeight: element.clientHeight, scrollHeight: element.scrollHeight, overflow: getComputedStyle(element).overflowY, display: getComputedStyle(element).display })))) });
      const dialogBox = (await dialog.boundingBox())!;
      const x = dialogBox.x + dialogBox.width / 2, y = Math.min(size.height - 100, dialogBox.y + dialogBox.height - 100);
      if (phone && browserName === "chromium") {
        const touch = await context.newCDPSession(page);
        try {
          await touch.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
          for (let i = 1; i <= 8; i++) await touch.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y: y - i * 18 }] });
          await touch.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
        } finally { await touch.detach(); }
      } else {
        await page.mouse.move(x, y); await page.mouse.wheel(0, 300);
      }
      // User input must really move content; programmatic scrollIntoView alone
      // would hide an overscroll-containment trap in a nested unconstrained list.
      await expect.poll(async () => (await first.boundingBox())!.y).toBeLessThan(before!.y - 30);
      await last.scrollIntoViewIfNeeded();
      await expect(last.getByRole("button", { name: "停止此任务", exact: true })).toBeInViewport({ ratio: 1 });
      await expect(dialog.getByRole("button", { name: "关闭任务列表", exact: true })).toBeInViewport({ ratio: 1 });
      await expect(dialog.getByRole("button", { name: "停止全部后台任务", exact: true })).toBeInViewport({ ratio: 1 });
      expect(await page.evaluate(() => window.scrollY)).toBe(0);
      expect(await dialog.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
      for (const theme of ["light", "dark"]) {
        await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
        await page.screenshot({ path: info.outputPath(`tasks-bottom-${theme}.png`), animations: "disabled" });
      }
      await last.getByRole("button", { name: "停止此任务", exact: true }).click();
      await expect(last).toContainText("已停止");
      expect(await page.evaluate(() => (window as any).taskFixture.calls.filter((call: any) => call.input).map((call: any) => call.input.taskId))).toEqual(["extra-12"]);
    } finally { await context.close(); }
  });
}
