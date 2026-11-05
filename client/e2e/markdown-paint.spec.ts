import { expect, test, type Page } from "@playwright/test";
import { createServer } from "./fixtures/vite.js";

async function holdPaints(page: Page) {
  await page.evaluate(() => {
    let id = 10_000;
    const held = new Map<number, FrameRequestCallback>();
    window.requestAnimationFrame = callback => { held.set(++id, callback); return id; };
    window.cancelAnimationFrame = request => { held.delete(request); };
    Object.assign(window, { heldPaints: held });
  });
}
async function finishPaints(page: Page, count: number) {
  for (let step = 0; step < 30; step++) {
    if (await page.locator(".markdown p").count() === count) break;
    const previous = await page.locator(".markdown p").count();
    await page.evaluate(() => {
      const held: Map<number, FrameRequestCallback> = (window as any).heldPaints;
      const pending = [...held.values()]; held.clear(); pending.forEach(callback => callback(performance.now()));
    });
    await expect.poll(() => page.locator(".markdown p").count()).toBeGreaterThan(previous);
  }
  await expect(page.locator(".markdown p")).toHaveCount(count);
  expect(await page.evaluate(() => (window as any).heldPaints.size)).toBe(0);
}

for (const append of [false, true]) test(`progressive painting completes in order with a retained prefix (append=${append})`, async ({ page }) => {
  const server = await createServer({ server: { port: 0, host: "127.0.0.1" } }); await server.listen();
  try {
    await page.goto(server.resolvedUrls!.local[0] + "e2e/fixtures/markdown.html");
    await expect(page.locator(".markdown p")).toHaveText("start");
    await holdPaints(page);
    const rows = Array.from({ length: 500 }, (_, i) => `PARAGRAPH_${i}`);
    await page.evaluate(text => (window as any).setMarkdown(text), rows.join("\n\n"));
    await expect(page.locator(".markdown p").first()).toHaveText(rows[0]);
    const first = await page.locator(".markdown p").first().elementHandle();
    const before = await page.locator(".markdown p").count();
    expect(before).toBeLessThan(rows.length);
    if (append) {
      rows.push(...Array.from({ length: 250 }, (_, i) => `PARAGRAPH_${i + 500}`));
      await page.evaluate(text => (window as any).setMarkdown(text), rows.join("\n\n"));
      // No frame is released here: the newer parse must itself advance, not
      // reset the already visible prefix or wait for the old document to end.
      await expect.poll(() => page.locator(".markdown p").count()).toBeGreaterThan(before);
    }
    await finishPaints(page, rows.length);
    expect(await page.locator(".markdown p").allTextContents()).toEqual(rows);
    expect(await first!.evaluate(node => node.isConnected)).toBe(true);
    await first!.dispose();
  } finally { await page.close(); await server.close(); }
});

test("a rejection during progressive painting preserves raw text and explicit retry completes", async ({ page }) => {
  const server = await createServer({ server: { port: 0, host: "127.0.0.1" } }); await server.listen();
  try {
    await page.route(/\/src\/markdown\.worker\.ts\?.*worker_file/, async route => {
      const response = await route.fetch();
      const prefix = `let rejected = false; self.addEventListener("message", event => {
        if (!rejected && event.data.text?.includes("REJECT_ONCE")) {
          rejected = true; event.stopImmediatePropagation(); self.postMessage({ id: event.data.id, error: "test_rejection" });
        }
      });\n`;
      await route.fulfill({ response, body: prefix + await response.text() });
    });
    await page.goto(server.resolvedUrls!.local[0] + "e2e/fixtures/markdown.html");
    await expect(page.locator(".markdown p")).toHaveText("start");
    await holdPaints(page);
    const rows = Array.from({ length: 500 }, (_, i) => `PARAGRAPH_${i}`);
    await page.evaluate(text => (window as any).setMarkdown(text), rows.join("\n\n"));
    await expect(page.locator(".markdown p").first()).toHaveText(rows[0]);
    rows.push("REJECT_ONCE <img src=x onerror=alert(1)>");
    await page.evaluate(text => (window as any).setMarkdown(text), rows.join("\n\n"));
    await expect(page.locator(".markdown-pending")).toHaveText(rows.join("\n\n"));
    await expect(page.locator(".markdown img")).toHaveCount(0);
    expect(await page.evaluate(() => (window as any).heldPaints.size)).toBe(0);
    await page.getByRole("button", { name: "恢复排版", exact: true }).click();
    await expect(page.locator(".markdown p").first()).toHaveText(rows[0]);
    expect(await page.locator(".markdown p").count()).toBeLessThan(rows.length);
    await finishPaints(page, rows.length);
    expect((await page.locator(".markdown p").allTextContents()).slice(0, 500)).toEqual(rows.slice(0, 500));
    await expect(page.locator(".markdown img")).toHaveCount(0);
  } finally { await page.close(); await server.close(); }
});

for (const remount of [false, true]) test(`a pending long-document paint cannot overwrite a newer document (remount=${remount})`, async ({ page }) => {
  const server = await createServer({ server: { port: 0, host: "127.0.0.1" } }); await server.listen();
  try {
    await page.goto(server.resolvedUrls!.local[0] + "e2e/fixtures/markdown.html");
    await expect(page.locator(".markdown p")).toHaveText("start");
    await page.evaluate(() => {
      let id = 10_000;
      const held = new Map<number, FrameRequestCallback>(), cancelled: number[] = [];
      window.requestAnimationFrame = callback => { held.set(++id, callback); return id; };
      window.cancelAnimationFrame = request => { cancelled.push(request); };
      Object.assign(window, { paintProbe: { held, cancelled } });
      (window as any).setMarkdown(Array.from({ length: 500 }, (_, i) => `OLD_BLOCK_${i}\n\n`).join(""));
    });
    await expect(page.locator(".markdown p").first()).toHaveText("OLD_BLOCK_0");
    expect(await page.locator(".markdown p").count()).toBeLessThan(500);
    expect(await page.evaluate(() => (window as any).paintProbe.held.size)).toBeGreaterThan(0);
    await page.evaluate(freshOwner => {
      const api = window as any;
      if (freshOwner) api.remountMarkdown("LATEST_DOCUMENT"); else api.setMarkdown("LATEST_DOCUMENT");
    }, remount);
    await expect(page.locator(".markdown p")).toHaveText("LATEST_DOCUMENT");
    await page.evaluate(() => {
      const probe = (window as any).paintProbe;
      // Also force a cancelled callback to run: its revision/lifetime guard
      // must protect the document, not only the browser's cancellation API.
      const pending = [...probe.held.values()] as FrameRequestCallback[];
      probe.held.clear(); pending.forEach(callback => callback(performance.now()));
    });
    await expect(page.locator(".markdown p")).toHaveText("LATEST_DOCUMENT");
    expect(await page.evaluate(() => (window as any).paintProbe.cancelled.length)).toBeGreaterThan(0);
  } finally { await page.close(); await server.close(); }
});
