import { test, expect } from "@playwright/test";
import { imageViewerFixture } from "./fixtures/image-viewer.js";

for (const width of [390, 1360]) test(`mouse closes only on empty backdrop, including narrow desktop windows (${width})`, async ({ page }) => {
  await page.setViewportSize({ width, height: 900 });
  const env = await imageViewerFixture(page);
  try {
    const opener = page.getByRole("button", { name: "第一张", exact: true });
    await opener.click();
    const viewer = page.getByRole("dialog", { name: "图片预览", exact: true }), image = viewer.locator("img");
    await expect(image).toBeVisible();
    const fit = (await image.boundingBox())!.width;
    await image.click();
    await expect(viewer).toHaveAttribute("data-controls", "hidden");
    await expect(viewer).toBeVisible();
    await image.dblclick({ delay: 60 });
    await expect.poll(async () => (await image.boundingBox())!.width).toBeGreaterThan(fit * 2);
    await page.keyboard.press("0");
    await expect.poll(async () => (await image.boundingBox())!.width).toBeCloseTo(fit, 0);
    // Dragging across the image edge is not an empty-backdrop click.
    const bounds = (await image.boundingBox())!;
    await page.mouse.move(width / 2, bounds.y + 10); await page.mouse.down();
    await page.mouse.move(width / 2, bounds.y - 30, { steps: 4 }); await page.mouse.up();
    await page.waitForTimeout(400); await expect(viewer).toBeVisible();
    await page.mouse.click(width / 2, bounds.y / 2);
    await expect(viewer).toHaveCount(0); await expect(opener).toBeFocused();
  } finally { await page.close(); await env.close(); }
});

for (const width of [390, 1024]) test(`touch taps toggle controls at fit and zoomed sizes without closing or moving the image (${width})`, async ({ browser }, info) => {
  const context = await browser.newContext({ viewport: { width, height: 900 }, hasTouch: true, reducedMotion: "reduce" });
  const page = await context.newPage(), env = await imageViewerFixture(page);
  try {
    const opener = page.getByRole("button", { name: "第一张", exact: true });
    await opener.tap();
    const viewer = page.getByRole("dialog", { name: "图片预览", exact: true }), image = viewer.locator("img");
    await expect(image).toBeVisible();
    await expect(image).toHaveAttribute("decoding", "sync");
    // An idle identity 3D transform can leave decoded photos unpainted in
    // Android WebViews. Compositing is only needed during a swipe.
    await expect(viewer.locator(".image-preview-canvas")).toHaveCSS("transform", "none");
    const fitted = (await image.boundingBox())!, fit = fitted.width;
    await page.touchscreen.tap(width / 2, 450);
    await expect(viewer).toHaveAttribute("data-controls", "hidden");
    await expect(viewer.locator("header")).toHaveCSS("opacity", "0");
    expect(await image.boundingBox()).toEqual(fitted);
    await page.screenshot({ path: info.outputPath(`touch-fullscreen-${width}.png`) });
    await page.touchscreen.tap(width / 2, 450);
    await expect(viewer).toHaveAttribute("data-controls", "visible");
    expect(await image.boundingBox()).toEqual(fitted);
    await page.touchscreen.tap(width / 2, 450); await page.touchscreen.tap(width / 2, 450);
    await expect.poll(async () => (await image.boundingBox())!.width).toBeGreaterThan(fit * 2);
    await page.waitForTimeout(400); await expect(viewer).toBeVisible();
    await page.touchscreen.tap(width / 2, 450);
    await expect(viewer).toHaveAttribute("data-controls", "hidden");
    await expect(viewer).toBeVisible();
    await page.touchscreen.tap(width / 2, 450); await page.touchscreen.tap(width / 2, 450);
    await expect.poll(async () => (await image.boundingBox())!.width).toBeCloseTo(fit, 0);
    await page.waitForTimeout(400); await expect(viewer).toBeVisible();
    await page.screenshot({ path: info.outputPath(`touch-fit-${width}.png`) });
    await page.touchscreen.tap(width / 2, 450);
    await expect(viewer).toHaveAttribute("data-controls", "visible");
    await viewer.getByRole("button", { name: "关闭", exact: true }).tap();
    await expect(viewer).toHaveCount(0); await expect(opener).toBeFocused();
  } finally { await context.close(); await env.close(); }
});

test("keyboard navigation cancels a pending touch toggle before focusing the toolbar", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1024, height: 900 }, hasTouch: true });
  const page = await context.newPage(), env = await imageViewerFixture(page);
  try {
    await page.getByRole("button", { name: "第一张", exact: true }).tap();
    const viewer = page.getByRole("dialog", { name: "图片预览", exact: true });
    await expect(viewer.locator("img")).toBeVisible();
    await page.touchscreen.tap(512, 450);
    await page.keyboard.press("Tab");
    await expect(viewer.getByRole("button", { name: "下一张", exact: true })).toBeFocused();
    await page.waitForTimeout(400);
    await expect(viewer).toBeVisible();
    await expect(viewer).toHaveAttribute("data-controls", "visible");
    await page.keyboard.press("Enter");
    await expect(viewer.locator("img")).toHaveAttribute("alt", "第二张");
  } finally { await context.close(); await env.close(); }
});

test("a toolbar action or gallery change cancels a pending touch toggle", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 900 }, hasTouch: true });
  const page = await context.newPage(), env = await imageViewerFixture(page);
  try {
    await page.getByRole("button", { name: "第一张", exact: true }).tap();
    const viewer = page.getByRole("dialog", { name: "图片预览", exact: true });
    await expect(viewer.locator("img")).toBeVisible();
    await page.touchscreen.tap(195, 450);
    await viewer.getByRole("button", { name: "下一张", exact: true }).tap();
    await expect(viewer.locator("img")).toHaveAttribute("alt", "第二张");
    await page.waitForTimeout(400); await expect(viewer).toBeVisible();
    await expect(viewer).toHaveAttribute("data-controls", "visible");
    await page.touchscreen.tap(195, 450);
    await viewer.getByRole("button", { name: "放大图片", exact: true }).tap();
    await page.waitForTimeout(400);
    await expect(viewer.getByRole("button", { name: "还原图片", exact: true })).toBeVisible();
    await viewer.getByRole("button", { name: "还原图片", exact: true }).tap();
    await page.touchscreen.tap(195, 450);
    await viewer.getByRole("button", { name: "关闭", exact: true }).tap();
    await page.getByRole("button", { name: "第一张", exact: true }).tap();
    await page.waitForTimeout(400); await expect(viewer).toBeVisible();
    await expect(viewer).toHaveAttribute("data-controls", "visible");
  } finally { await context.close(); await env.close(); }
});

for (const width of [390, 1360]) test(`image viewer uses the full canvas and toggles chrome without moving the image (${width})`, async ({ page }, info) => {
  await page.setViewportSize({ width, height: 900 });
  const env = await imageViewerFixture(page);
  try {
    await page.locator(`[data-message-id="${env.batch.id}"]`).getByRole("button", { name: "第一张", exact: true }).click();
    const viewer = page.getByRole("dialog", { name: "图片预览", exact: true });
    const image = viewer.locator("img"), reader = viewer.getByLabel("完整图片", { exact: true });
    await expect(image).toBeVisible();
    await page.screenshot({ path: info.outputPath(`01-open-${width}.png`) });
    const close = viewer.getByRole("button", { name: "关闭", exact: true });
    await expect(viewer.locator('.image-preview-title')).toBeFocused();
    await expect(close).toHaveCSS('outline-style', 'none');
    await page.keyboard.press('Tab');
    await expect(close).toBeFocused();
    await expect(close).toHaveCSS('outline-style', 'solid');
    await expect(close).toHaveCSS('outline-offset', '-4px');
    await page.screenshot({ path: info.outputPath(`01-keyboard-close-${width}.png`) });
    const box = (await reader.boundingBox())!, before = (await image.boundingBox())!;
    expect(box.height).toBeGreaterThanOrEqual(899);
    await reader.click({ position: { x: box.width / 2, y: box.height / 2 } });
    await expect(viewer.getByRole("button", { name: "关闭", exact: true })).toBeHidden();
    expect(await image.boundingBox()).toEqual(before);
    await page.screenshot({ path: info.outputPath(`02-immersive-${width}.png`) });
    await reader.click({ position: { x: box.width / 2, y: box.height / 2 } });
    await expect(viewer.getByRole("button", { name: "关闭", exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(viewer).toHaveCount(0);
  } finally { await page.close(); await env.close(); }
});

test("modified wheel zoom stays anchored while ordinary wheel pans without changing scale or gallery", async ({ page }, info) => {
  const env = await imageViewerFixture(page);
  try {
    await page.getByRole("button", { name: "第一张", exact: true }).click();
    const viewer = page.getByRole("dialog", { name: "图片预览", exact: true }), image = viewer.locator("img");
    await expect(image).toBeVisible();
    const before = (await image.boundingBox())!, x = before.x + before.width * .35, y = before.y + before.height * .55;
    await page.mouse.move(x, y); await page.keyboard.down("Control"); await page.mouse.wheel(0, -240); await page.keyboard.up("Control");
    await expect.poll(async () => (await image.boundingBox())!.width).toBeGreaterThan(before.width * 1.2);
    const after = (await image.boundingBox())!;
    expect(Math.abs((x - after.x) / after.width - .35)).toBeLessThan(.025);
    expect(Math.abs((y - after.y) / after.height - .55)).toBeLessThan(.025);
    await expect(image).toHaveAttribute("alt", "第一张");
    await page.screenshot({ path: info.outputPath("03-pointer-zoom.png") });
    const reader = viewer.getByLabel("完整图片", { exact: true });
    const top = await reader.evaluate(node => node.scrollTop);
    await page.mouse.wheel(0, 120);
    await expect.poll(() => reader.evaluate(node => node.scrollTop)).toBeGreaterThan(top + 90);
    expect((await image.boundingBox())!.width).toBeCloseTo(after.width, 0);
    await page.mouse.down(); await page.mouse.move(x - 130, y - 90, { steps: 6 }); await page.mouse.up();
    await expect(image).toHaveAttribute("alt", "第一张");
    await page.keyboard.press("0");
    await expect.poll(async () => (await image.boundingBox())!.width).toBeCloseTo(before.width, 0);
  } finally { await page.close(); await env.close(); }
});

test("long image can fit the whole image then return to readable width", async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const env = await imageViewerFixture(page);
  try {
    await page.getByRole("button", { name: "长图", exact: true }).click();
    const viewer = page.getByRole("dialog", { name: "图片预览", exact: true }), image = viewer.locator("img");
    await expect(image).toBeVisible();
    expect((await image.boundingBox())!.height).toBeGreaterThan(3000);
    await viewer.getByRole("button", { name: "适应窗口", exact: true }).click();
    await expect.poll(async () => (await image.boundingBox())!.height).toBeLessThanOrEqual(844);
    await page.screenshot({ path: info.outputPath("04-long-fit.png") });
    await viewer.getByRole("button", { name: "适应宽度", exact: true }).click();
    await expect.poll(async () => (await image.boundingBox())!.width).toBeCloseTo(390, 0);
  } finally { await page.close(); await env.close(); }
});

test("hidden controls stay hidden during message delivery and Tab restores a reachable control", async ({ page }) => {
  const env = await imageViewerFixture(page);
  try {
    await page.getByRole("button", { name: "第一张", exact: true }).click();
    const viewer = page.getByRole("dialog", { name: "图片预览", exact: true });
    await expect(viewer.locator("img")).toBeVisible();
    await page.keyboard.press("h");
    await expect(viewer.getByRole("button", { name: "关闭", exact: true })).toBeHidden();
    await env.hub.store.publishBotMessage("photo", { conversationId: env.chat.id, blocks: [{ type: "text", text: "阅读图片时收到的新消息" }] });
    await expect(page.locator(".message.bot").getByText("阅读图片时收到的新消息", { exact: true })).toBeAttached();
    await expect(viewer.getByRole("button", { name: "关闭", exact: true })).toBeHidden();
    await page.keyboard.press("Tab");
    await expect(viewer.getByRole("button", { name: "关闭", exact: true })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("button", { name: "第一张", exact: true })).toBeFocused();
  } finally { await page.close(); await env.close(); }
});

test("WebKit trackpad gesture events zoom the photo and reset without page scaling", async ({ page }) => {
  const env = await imageViewerFixture(page);
  try {
    await page.getByRole("button", { name: "第一张", exact: true }).click();
    const viewer = page.getByRole("dialog", { name: "图片预览", exact: true }), image = viewer.locator("img");
    await expect(image).toBeVisible();
    const before = (await image.boundingBox())!;
    const reader = viewer.getByLabel("完整图片", { exact: true });
    // A contract check of WebKit's event API, not a physical trackpad claim.
    const prevented = await reader.evaluate(node => {
      const box = node.getBoundingClientRect();
      return ["gesturestart", "gesturechange", "gestureend"].map(type => {
        const event = new Event(type, { bubbles: true, cancelable: true });
        Object.assign(event, { scale: type === "gesturestart" ? 1 : 2, clientX: box.width / 2, clientY: box.height / 2 });
        node.dispatchEvent(event); return event.defaultPrevented;
      });
    });
    expect(prevented).toEqual([true, true, true]);
    await expect.poll(async () => (await image.boundingBox())!.width).toBeCloseTo(before.width * 2, 0);
    await page.keyboard.press("0");
    await expect.poll(async () => (await image.boundingBox())!.width).toBeCloseTo(before.width, 0);
  } finally { await page.close(); await env.close(); }
});

test("browser full screen keeps the image open on exit and restores the document on close", async ({ page, browserName }) => {
  test.skip(browserName !== "chromium", "browser fullscreen API; native macOS has a separate fixture");
  const env = await imageViewerFixture(page);
  try {
    const opener = page.getByRole("button", { name: "第一张", exact: true }); await opener.click();
    const viewer = page.getByRole("dialog", { name: "图片预览", exact: true });
    await viewer.getByRole("button", { name: "全屏", exact: true }).click();
    await expect.poll(() => page.evaluate(() => !!document.fullscreenElement)).toBe(true);
    await viewer.getByRole("button", { name: "退出全屏", exact: true }).click();
    await expect.poll(() => page.evaluate(() => !!document.fullscreenElement)).toBe(false);
    await expect(viewer).toBeVisible();
    await viewer.getByRole("button", { name: "全屏", exact: true }).click();
    await expect.poll(() => page.evaluate(() => !!document.fullscreenElement)).toBe(true);
    await viewer.getByRole("button", { name: "关闭", exact: true }).click();
    await expect(viewer).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => !!document.fullscreenElement)).toBe(false);
    await expect(opener).toBeFocused();
  } finally { await page.close(); await env.close(); }
});

for (const platform of ["android", "ios"] as const) test(`phone chrome toggles keep one native fullscreen lease (${platform})`, async ({ browser }, info) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, reducedMotion: "no-preference" });
  const page = await context.newPage();
  // Instrument the bridge before plugin registration; real App/UI code still
  // owns the lease. This observes calls, not an actual OS compositor.
  await page.addInitScript(() => {
    const win = window as any;
    win.readerCalls = [];
    win.Capacitor = {
      PluginHeaders: [
        { name: "TaroBotAppearance", methods: ["setCanvas", "setReaderCanvas", "setImmersive"].map(name => ({ name, rtype: "promise" })) },
        { name: "SystemBars", methods: ["setStyle", "hide", "show"].map(name => ({ name, rtype: "promise" })) },
        { name: "Keyboard", methods: [{ name: "setStyle", rtype: "promise" }] },
      ],
      nativePromise: async (plugin: string, method: string, options: unknown) => { win.readerCalls.push({ plugin, method, options }); },
    };
  });
  const env = await imageViewerFixture(page);
  try {
    await page.evaluate(platform => {
      const win = window as any;
      win.Capacitor.getPlatform = () => platform; win.Capacitor.isNativePlatform = () => true;
      win.readerCalls = [];
      // Android reports these even with bars hidden; iOS uses env(safe-area-*).
      document.documentElement.style.setProperty("--image-safe-top", "47px");
      document.documentElement.style.setProperty("--image-safe-bottom", "34px");
    }, platform);
    const calls = () => page.evaluate(() => (window as any).readerCalls.filter((call: any) => call.method === "setImmersive" || call.method === "hide" || call.method === "show"));
    const opener = page.getByRole("button", { name: "第一张", exact: true });
    await opener.tap();
    const viewer = page.getByRole("dialog", { name: "图片预览", exact: true }), image = viewer.locator("img");
    await expect(image).toBeVisible();
    await expect.poll(calls).toHaveLength(1);
    expect((await calls())[0]).toMatchObject(platform === "android" ? { method: "setImmersive", options: { enabled: true } } : { method: "hide" });
    const before = (await image.boundingBox())!;
    expect((await viewer.getByRole("button", { name: "关闭", exact: true }).boundingBox())!.y).toBeGreaterThanOrEqual(47);
    const controls = (await viewer.locator("footer").boundingBox())!;
    expect(controls.y + controls.height).toBeLessThanOrEqual(844 - 34);
    for (let cycle = 0; cycle < 2; cycle++) {
      // Cover both empty canvas and the image itself, without releasing the
      // native fullscreen lease or changing the photo geometry.
      const tapY = cycle === 0 ? 180 : before.y + before.height / 2;
      await page.touchscreen.tap(195, tapY);
      await expect(viewer).toHaveAttribute("data-controls", "hidden");
      await expect(viewer.locator("header")).toHaveCSS("opacity", "0");
      await expect(viewer.locator(".image-preview-scroll")).toHaveCSS("outline-style", "none");
      expect(await image.boundingBox()).toEqual(before);
      expect(await calls()).toHaveLength(1);
      if (cycle === 0) await page.screenshot({ path: info.outputPath(`phone-hidden-${platform}.png`) });
      await page.touchscreen.tap(195, tapY);
      await expect(viewer).toHaveAttribute("data-controls", "visible");
      await expect(viewer.locator("header")).toHaveCSS("opacity", "1");
      expect(await image.boundingBox()).toEqual(before);
      expect(await calls()).toHaveLength(1);
    }
    await page.screenshot({ path: info.outputPath(`phone-controls-${platform}.png`) });
    await viewer.getByRole("button", { name: "关闭", exact: true }).tap();
    await expect(viewer).toHaveCount(0); await expect.poll(calls).toHaveLength(2);
    expect((await calls())[1]).toMatchObject(platform === "android" ? { method: "setImmersive", options: { enabled: false } } : { method: "show" });
    await expect(opener).toBeFocused();
  } finally { await context.close(); await env.close(); }
});
