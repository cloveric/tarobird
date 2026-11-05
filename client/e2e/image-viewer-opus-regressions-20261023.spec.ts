import { preparePairing } from "./fixtures/pairing-invite.js";
import { test, expect, type Browser, type Page, type Locator } from "@playwright/test";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HubServer } from "../../src/hub/server.js";
import { showDisconnectedBots, selectConversation, waitForClientOnline } from "./fixtures/mobile.js";

// Image viewer contract from the 2026-10-23 audit. Assertions use roles, labels
// and geometry only, so a different DOM structure can still satisfy them.
//   "defect" tests reproduce confirmed failures of 914581b;
//   "intended" tests describe the agreed redesign (not baseline defects);
//   "stress" tests guard races that were not reproduced on 914581b.

type Spec = readonly [title: string, width: number, height: number, broken?: boolean];
const SPECS: Spec[] = [["第一张", 1600, 900], ["坏图", 800, 600, true], ["长图", 720, 7200], ["全景", 8000, 1000]];

async function fixture(page: Page, options: { slow?: string } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "viewer-contract-"));
  const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve("dist") });
  let release = () => {};
  try {
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('photo','图片助手','fixture')");
    const chat = await hub.store.createConversation("owner", ["photo"], "查看器契约", "viewer");
    await page.goto(hub.url);
    const paint = (width: number, height: number) => page.evaluate(({ width, height }) => {
      const canvas = document.createElement("canvas"); canvas.width = width; canvas.height = height;
      const ctx = canvas.getContext("2d")!;
      for (let x = 0; x < 10; x++) for (let y = 0; y < 10; y++) { ctx.fillStyle = `rgb(${x * 25},${y * 25},128)`; ctx.fillRect(x * width / 10, y * height / 10, width / 10, height / 10); }
      return canvas.toDataURL("image/png").split(",")[1]!;
    }, { width, height });
    const elements = [], ids = new Map<string, string>();
    for (const [title, width, height, broken] of SPECS) {
      // Undecodable bytes behind an image MIME exercise the viewer's error state.
      const bytes = broken ? Buffer.from("not really a png ".repeat(64)) : Buffer.from(await paint(width, height), "base64");
      const id = await hub.attachments.importForBot("photo", { conversationId: chat.id, name: title + ".png", mime: "image/png", size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") }, bytes);
      ids.set(title, id); elements.push({ type: "image" as const, attachmentId: id, text: title });
    }
    if (options.slow) {
      // Hold one original in the Hub so the viewer stays in its loading state.
      const held = ids.get(options.slow)!, gate = new Promise<void>(resolve => { release = resolve; });
      const download = hub.attachments.download.bind(hub.attachments);
      hub.attachments.download = async (actor, id) => { if (id === held) await gate; return download(actor, id); };
    }
    const batch = await hub.store.publishBotMessage("photo", { conversationId: chat.id, blocks: [{ type: "text", text: "契约图片" }, { type: "card", elements }] });
    const png = Buffer.from(await paint(1200, 800), "base64");
    const fileId = await hub.attachments.importForBot("photo", { conversationId: chat.id, name: "作为文件.png", mime: "image/png", size: png.length, sha256: createHash("sha256").update(png).digest("hex") }, png);
    await hub.store.publishBotMessage("photo", { conversationId: chat.id, blocks: [{ type: "file", attachmentId: fileId, name: "作为文件.png", mime: "image/png", size: png.length }] });
    await hub.store.publishBotMessage("photo", { conversationId: chat.id, blocks: [{ type: "text", text: "外链图片：![外部示意图](https://example.com/outside.png)" }] });
    await preparePairing(page, hub); await page.getByRole("button", { name: "配对此设备", exact: true }).click();
    await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
    await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" });
    await waitForClientOnline(page); await showDisconnectedBots(page); await selectConversation(page, chat.title);
    return { row: page.locator(`[data-message-id="${batch.id}"]`), png, release: () => release(), close: async () => { release(); await hub.close(); await rm(root, { recursive: true, force: true }); } };
  } catch (error) { release(); await hub.close(); await rm(root, { recursive: true, force: true }); throw error; }
}

/** Chromium trusted touch input through CDP, including native fling. */
async function phone(browser: Browser, viewport = { width: 390, height: 844 }) {
  const context = await browser.newContext({ viewport, hasTouch: true, reducedMotion: "no-preference" });
  const page = await context.newPage(), cdp = await context.newCDPSession(page);
  const touch = (type: "touchStart" | "touchMove" | "touchEnd", touchPoints: { id: number; x: number; y: number }[]) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints });
  return { context, page, touch };
}

const viewerOf = (page: Page) => page.getByRole("dialog", { name: "图片预览", exact: true });
const picture = (scope: Locator, title: string) => scope.getByRole("img", { name: title, exact: true });
const decoded = (image: Locator, width: number) => expect.poll(() => image.evaluate((n: HTMLImageElement) => n.complete ? n.naturalWidth : 0)).toBe(width);
const centre = async (scope: Locator) => { const r = (await scope.boundingBox())!; return { x: r.x + r.width / 2, y: r.y + r.height / 2, r }; };
const width = async (image: Locator) => (await image.boundingBox())!.width;
/** Image-relative fraction under a viewport point; geometry, not implementation state. */
const fraction = (image: Locator, x: number, y: number) => image.evaluate((n, p) => {
  const r = n.getBoundingClientRect(); return { fx: (p.x - r.left) / r.width, fy: (p.y - r.top) / r.height, width: r.width, height: r.height };
}, { x, y });
const settle = (page: Page) => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const chromiumOnly = (browserName: string) => test.skip(browserName !== "chromium", "CDP touch input");

test.describe("defect", () => {
  test("B2 touch swipe leaves decode-error and loading images; vertical and zoomed drags never navigate", async ({ browser, browserName }) => {
    chromiumOnly(browserName);
    const { context, page, touch } = await phone(browser), env = await fixture(page, { slow: "长图" });
    try {
      await env.row.getByRole("button", { name: "第一张", exact: true }).click();
      const viewer = viewerOf(page), position = viewer.getByLabel("图片位置");
      await decoded(picture(viewer, "第一张"), 1600);
      const drag = async (dx: number, dy = 0) => {
        const { x, y } = await centre(viewer);
        await touch("touchStart", [{ id: 1, x: x - dx / 2, y: y - dy / 2 }]);
        for (let i = 1; i <= 6; i++) { await touch("touchMove", [{ id: 1, x: x - dx / 2 + dx * i / 6, y: y - dy / 2 + dy * i / 6 }]); await page.waitForTimeout(16); }
        await touch("touchEnd", []); await page.waitForTimeout(250);
      };
      await drag(40, -220); await expect(position).toHaveText("1 / 4"); // vertical-dominant: no navigation
      await viewer.getByRole("button", { name: "放大图片", exact: true }).click();
      await drag(-200); await expect(position).toHaveText("1 / 4"); // zoomed: pan, never navigate
      await viewer.getByRole("button", { name: "还原图片", exact: true }).click();
      await viewer.getByRole("button", { name: "下一张", exact: true }).click();
      await expect(position).toHaveText("2 / 4"); await expect(viewer.getByRole("alert")).toBeVisible();
      await drag(-200); await expect(position).toHaveText("3 / 4"); // out of the decode error
      await expect(picture(viewer, "长图")).toHaveCount(0); // still held by the Hub: loading
      await drag(-200); await expect(position).toHaveText("4 / 4"); // out of loading, forwards
      await viewer.getByRole("button", { name: "上一张", exact: true }).click(); await expect(position).toHaveText("3 / 4");
      await drag(200); await expect(position).toHaveText("2 / 4"); // out of loading, backwards
      await drag(200); await expect(position).toHaveText("1 / 4"); // out of the decode error, backwards
      env.release();
    } finally { await context.close(); await env.close(); }
  });

  test("B3 a real touch flick on a long image keeps scrolling after release and never navigates", async ({ browser, browserName }) => {
    chromiumOnly(browserName);
    const { context, page, touch } = await phone(browser), env = await fixture(page);
    try {
      await env.row.getByRole("button", { name: "长图", exact: true }).click();
      const viewer = viewerOf(page), image = picture(viewer, "长图");
      await decoded(image, 720);
      const start = (await image.boundingBox())!;
      expect(start.height).toBeGreaterThan(844 * 2); // readable width-fit start, not fit-whole
      const { x, y } = await centre(viewer), travel = 300;
      await touch("touchStart", [{ id: 1, x, y: y + travel / 2 }]);
      for (let i = 1; i <= 5; i++) await touch("touchMove", [{ id: 1, x, y: y + travel / 2 - travel * i / 5 }]);
      await touch("touchEnd", []);
      const released = (await image.boundingBox())!.y;
      await page.waitForTimeout(900);
      const coasted = (await image.boundingBox())!.y;
      expect(start.y - released, "the finger moved the page").toBeGreaterThan(travel * 0.5);
      expect(released - coasted, `coast after release: ${released} -> ${coasted}`).toBeGreaterThan(travel * 0.2);
      await expect(viewer.getByLabel("图片位置")).toHaveText("3 / 4");
      // A tap used to stop a new fling must not toggle controls or dismiss.
      await touch("touchStart", [{ id: 1, x, y: y + travel / 2 }]);
      for (let i = 1; i <= 5; i++) await touch("touchMove", [{ id: 1, x, y: y + travel / 2 - travel * i / 5 }]);
      await touch("touchEnd", []);
      await touch("touchStart", [{ id: 1, x, y }]); await touch("touchEnd", []);
      await page.waitForTimeout(400); await expect(viewer).toBeVisible();
      await expect(viewer).toHaveAttribute("data-controls", "visible");
      // A stationary long press is never an ordinary fit-size tap.
      await touch("touchStart", [{ id: 1, x, y }]); await page.waitForTimeout(420); await touch("touchEnd", []);
      await page.waitForTimeout(400); await expect(viewer).toBeVisible();
      await expect(viewer).toHaveAttribute("data-controls", "visible");
    } finally { await context.close(); await env.close(); }
  });

  for (const [label, from, to] of [["desktop resize", { width: 1360, height: 900 }, { width: 900, height: 700 }], ["phone rotation", { width: 390, height: 844 }, { width: 844, height: 390 }]] as const) {
    test(`B4 ${label} while zoomed keeps the image point under the viewport centre`, async ({ browser }) => {
      const context = await browser.newContext({ viewport: from, hasTouch: from.width < 760 });
      const page = await context.newPage(), env = await fixture(page);
      try {
        await env.row.getByRole("button", { name: "第一张", exact: true }).click();
        const viewer = viewerOf(page), image = picture(viewer, "第一张");
        await decoded(image, 1600);
        const fit = await width(image);
        await viewer.getByRole("button", { name: "放大图片", exact: true }).click();
        await expect.poll(() => width(image)).toBeGreaterThan(fit * 2);
        await settle(page);
        // The zoomed point is mid-image, so no edge clamping is needed after resizing.
        const a = await centre(viewer), before = await fraction(image, a.x, a.y);
        await page.setViewportSize(to); await settle(page); await page.waitForTimeout(250);
        const b = await centre(viewer), after = await fraction(image, b.x, b.y);
        const detail = JSON.stringify({ before, after });
        expect(Math.abs(after.fx - before.fx) * after.width, detail).toBeLessThan(24);
        expect(Math.abs(after.fy - before.fy) * after.height, detail).toBeLessThan(24);
      } finally { await context.close(); await env.close(); }
    });
  }

  test("B5 page, arrow and Home/End keys scroll an overflowing long image from the initial focus", async ({ page }) => {
    await page.setViewportSize({ width: 1360, height: 900 });
    const env = await fixture(page);
    try {
      await env.row.getByRole("button", { name: "长图", exact: true }).click();
      const viewer = viewerOf(page), image = picture(viewer, "长图");
      await decoded(image, 720);
      const frame = (await viewer.boundingBox())!, top = async () => { await settle(page); await page.waitForTimeout(250); return (await image.boundingBox())!.y; };
      const initial = await top();
      test.skip((await image.boundingBox())!.height <= frame.height, "long image opened fit-whole on desktop; nothing to scroll");
      await page.keyboard.press("PageDown"); const paged = await top(); expect(paged).toBeLessThan(initial - 200);
      await page.keyboard.press("ArrowDown"); const arrowed = await top(); expect(arrowed).toBeLessThan(paged - 20);
      await page.keyboard.press("ArrowUp"); expect(await top()).toBeGreaterThan(arrowed + 20);
      await page.keyboard.press("PageUp"); expect(await top()).toBeGreaterThan(paged + 100);
      await page.keyboard.press("End"); await top();
      const bottom = (await image.boundingBox())!; expect(bottom.y + bottom.height).toBeLessThan(frame.y + frame.height + 2);
      await page.keyboard.press("Home"); expect(Math.abs(await top() - initial)).toBeLessThan(2);
      await expect(viewer).toBeVisible();
    } finally { await env.close(); }
  });

  test("B6 Ctrl+wheel zooms the photo around the cursor and never zooms the App; +/- keys zoom", async ({ page }) => {
    await page.setViewportSize({ width: 1360, height: 900 });
    const env = await fixture(page);
    try {
      await env.row.getByRole("button", { name: "第一张", exact: true }).click();
      const viewer = viewerOf(page), image = picture(viewer, "第一张");
      await decoded(image, 1600);
      const { r } = await centre(viewer), at = { x: r.x + r.width * 0.7, y: r.y + r.height * 0.4 };
      await page.mouse.move(at.x, at.y);
      const before = await fraction(image, at.x, at.y);
      await page.evaluate(() => { (window as any).ctrlWheel = []; window.addEventListener("wheel", e => { if (e.ctrlKey) (window as any).ctrlWheel.push(e.defaultPrevented); }); });
      await page.keyboard.down("Control"); await page.mouse.wheel(0, -300); await page.keyboard.up("Control");
      await expect.poll(() => width(image)).toBeGreaterThan(before.width * 1.1);
      await settle(page); await page.waitForTimeout(150);
      const after = await fraction(image, at.x, at.y);
      expect(Math.abs(after.fx - before.fx) * after.width).toBeLessThan(16);
      expect(Math.abs(after.fy - before.fy) * after.height).toBeLessThan(16);
      expect(await page.evaluate(() => (window as any).ctrlWheel)).not.toContain(false);
      const zoomed = await width(image);
      await page.keyboard.press("+"); await expect.poll(() => width(image)).toBeGreaterThan(zoomed * 1.05);
      await page.keyboard.press("-"); await page.keyboard.press("-"); await expect.poll(() => width(image)).toBeLessThan(zoomed);
    } finally { await env.close(); }
  });

  test("B6 WebKit trackpad gesture events zoom the photo and are consumed (synthetic events)", async ({ page, browserName }) => {
    test.skip(browserName !== "webkit", "Safari/WKWebView gesture events");
    await page.setViewportSize({ width: 1360, height: 900 });
    const env = await fixture(page);
    try {
      await env.row.getByRole("button", { name: "第一张", exact: true }).click();
      const viewer = viewerOf(page), image = picture(viewer, "第一张");
      await decoded(image, 1600);
      const fit = await width(image), { x, y } = await centre(viewer);
      // Playwright cannot drive a physical trackpad. Dispatch WebKit's gesture
      // sequence at the photo; this is not device acceptance for a Mac trackpad.
      const prevented = await page.evaluate(({ x, y }) => {
        const target = document.elementFromPoint(x, y)!, results: boolean[] = [];
        for (const [type, scale] of [["gesturestart", 1], ["gesturechange", 1.4], ["gesturechange", 2], ["gestureend", 2]] as const) {
          const event = new Event(type, { bubbles: true, cancelable: true });
          Object.assign(event, { scale, clientX: x, clientY: y });
          target.dispatchEvent(event); results.push(event.defaultPrevented);
        }
        return results;
      }, { x, y });
      expect(prevented).not.toContain(false);
      await expect.poll(() => width(image)).toBeGreaterThan(fit * 1.5);
    } finally { await env.close(); }
  });

  test("B7 draft and file-block images open the shared zoomable viewer; Markdown images stay external links", async ({ browser, browserName }) => {
    chromiumOnly(browserName);
    const { context, page, touch } = await phone(browser), env = await fixture(page);
    const doubleTap = async (image: Locator) => {
      const b = (await image.boundingBox())!, p = { id: 1, x: b.x + b.width / 2, y: b.y + b.height / 2 };
      for (let i = 0; i < 2; i++) { await touch("touchStart", [p]); await touch("touchEnd", []); await page.waitForTimeout(60); }
    };
    try {
      const link = page.getByRole("link", { name: /外部示意图/ });
      await expect(link).toHaveAttribute("href", "https://example.com/outside.png");
      await expect(link.locator("img")).toHaveCount(0);
      await page.locator('input[type="file"][multiple]').setInputFiles({ name: "草稿图.png", mimeType: "image/png", buffer: env.png });
      await page.getByRole("button", { name: "预览 草稿图.png", exact: true }).click();
      const draft = viewerOf(page), draftImage = picture(draft, "草稿图.png");
      await decoded(draftImage, 1200);
      const draftFit = await width(draftImage);
      await doubleTap(draftImage);
      await expect.poll(() => width(draftImage)).toBeGreaterThan(draftFit * 1.5);
      await page.keyboard.press("Escape"); await expect(draft).toHaveCount(0);
      await page.getByRole("region", { name: "作为文件.png", exact: true }).getByRole("button", { name: /预览/ }).first().click();
      const file = viewerOf(page), fileImage = picture(file, "作为文件.png");
      await decoded(fileImage, 1200);
      const fileFit = await width(fileImage);
      await doubleTap(fileImage);
      await expect.poll(() => width(fileImage)).toBeGreaterThan(fileFit * 1.5);
    } finally { await context.close(); await env.close(); }
  });
});

test.describe("intended", () => {
  test("single taps toggle chrome at any zoom; double tap restores fit without closing", async ({ browser, browserName }) => {
    chromiumOnly(browserName);
    const { context, page, touch } = await phone(browser), env = await fixture(page);
    try {
      await env.row.getByRole("button", { name: "第一张", exact: true }).click();
      const viewer = viewerOf(page), image = picture(viewer, "第一张"), close = viewer.getByRole("button", { name: "关闭", exact: true });
      await decoded(image, 1600);
      const tap = async () => { const { x, y } = await centre(viewer); await touch("touchStart", [{ id: 1, x, y }]); await touch("touchEnd", []); };
      const fit = await width(image);
      await tap(); await page.waitForTimeout(60); await tap();
      await expect.poll(() => width(image)).toBeGreaterThan(fit * 1.5);
      const placed = (await image.boundingBox())!, unmoved = async () => {
        const now = (await image.boundingBox())!;
        return Math.max(Math.abs(now.x - placed.x), Math.abs(now.y - placed.y), Math.abs(now.width - placed.width), Math.abs(now.height - placed.height));
      };
      await tap(); await expect(close).toHaveCount(0); // hidden chrome leaves the accessibility tree
      expect(await unmoved()).toBeLessThan(1); // overlay chrome never reflows the canvas
      await tap(); await expect(close).toBeVisible();
      expect(await unmoved()).toBeLessThan(1);
      await tap(); await page.waitForTimeout(60); await tap();
      await expect.poll(() => width(image)).toBeCloseTo(fit, 0);
      await expect(close).toBeVisible();
      await tap(); await expect(close).toHaveCount(0);
      await expect(viewer).toBeVisible();
      await tap(); await expect(close).toBeVisible();
      await close.tap(); await expect(viewer).toHaveCount(0);
    } finally { await context.close(); await env.close(); }
  });

  test("desktop fullscreen keeps the dialog, Escape leaves fullscreen first, and closing restores the window", async ({ page, browserName }) => {
    chromiumOnly(browserName);
    await page.setViewportSize({ width: 1360, height: 900 });
    const env = await fixture(page);
    try {
      const open = async () => { await env.row.getByRole("button", { name: "第一张", exact: true }).click(); await decoded(picture(viewerOf(page), "第一张"), 1600); };
      const fullscreen = () => page.evaluate(() => !!document.fullscreenElement);
      await open();
      const viewer = viewerOf(page), enter = viewer.getByRole("button", { name: "全屏", exact: true });
      await expect(enter).toBeVisible(); await enter.click();
      await expect.poll(fullscreen).toBe(true);
      await expect(viewer.getByRole("button", { name: "退出全屏", exact: true })).toBeVisible();
      await page.keyboard.press("Escape");
      await expect.poll(fullscreen).toBe(false); await expect(viewer).toBeVisible();
      await page.keyboard.press("Escape"); await expect(viewer).toHaveCount(0);
      await expect.poll(fullscreen).toBe(false);
      await open();
      await viewer.getByRole("button", { name: "全屏", exact: true }).click(); await expect.poll(fullscreen).toBe(true);
      await viewer.getByRole("button", { name: "关闭", exact: true }).click();
      await expect(viewer).toHaveCount(0); await expect.poll(fullscreen).toBe(false);
      // Two trusted presses sent back to back, before the first request settles,
      // must leave the window as the second press asked.
      await open();
      const box = (await viewer.getByRole("button", { name: "全屏", exact: true }).boundingBox())!;
      const cdp = await page.context().newCDPSession(page), at = { x: box.x + box.width / 2, y: box.y + box.height / 2, button: "left" as const, clickCount: 1 };
      await Promise.all([1, 2].flatMap(() => [cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", ...at }), cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", ...at })]));
      await page.waitForTimeout(500);
      await expect.poll(fullscreen).toBe(false);
      await expect(viewer.getByRole("button", { name: "全屏", exact: true })).toBeVisible();
    } finally { await env.close(); }
  });

  test("a mouse drag at fit size never changes the photo on desktop", async ({ page }) => {
    await page.setViewportSize({ width: 1360, height: 900 });
    const env = await fixture(page);
    try {
      await env.row.getByRole("button", { name: "第一张", exact: true }).click();
      const viewer = viewerOf(page);
      await decoded(picture(viewer, "第一张"), 1600);
      const { x, y } = await centre(viewer);
      await page.mouse.move(x + 150, y); await page.mouse.down(); await page.mouse.move(x - 150, y, { steps: 8 }); await page.mouse.up();
      await page.waitForTimeout(400);
      await expect(viewer.getByLabel("图片位置")).toHaveText("1 / 4");
    } finally { await env.close(); }
  });
});

test.describe("stress", () => {
  test("B8 bursts of two-finger moves within one frame keep zoom state, label and swipe behavior coherent", async ({ browser, browserName }) => {
    chromiumOnly(browserName);
    const { context, page, touch } = await phone(browser), env = await fixture(page);
    try {
      await env.row.getByRole("button", { name: "第一张", exact: true }).click();
      const viewer = viewerOf(page), image = picture(viewer, "第一张"), position = viewer.getByLabel("图片位置");
      await decoded(image, 1600);
      const fit = await width(image), { x, y } = await centre(viewer);
      for (const spread of [6, 2, 0]) {
        // Unawaited moves reach the page back to back, as both fingers do in one frame.
        await touch("touchStart", [{ id: 1, x: x - 40, y }, { id: 2, x: x + 40, y }]);
        await Promise.all([1, 2, 3, 4, 5, 6].map(i => touch("touchMove", [{ id: 1, x: x - 40 - i * spread * 4, y }, { id: 2, x: x + 40 + i * spread * 4, y }])));
        await Promise.all([1, 2, 3].map(i => touch("touchMove", [{ id: 1, x: x - 40 - (6 - i * 2) * spread * 4, y }, { id: 2, x: x + 40 + (6 - i * 2) * spread * 4, y }])));
        await touch("touchEnd", []); await settle(page); await page.waitForTimeout(150);
        const zoomed = await width(image) > fit + 1;
        await expect(viewer.getByRole("button", { name: zoomed ? "还原图片" : "放大图片", exact: true })).toBeVisible();
      }
      const zoomed = await width(image) > fit + 1, from = await position.textContent();
      await touch("touchStart", [{ id: 1, x: x + 100, y }]);
      for (let i = 1; i <= 6; i++) { await touch("touchMove", [{ id: 1, x: x + 100 - i * 35, y }]); await page.waitForTimeout(16); }
      await touch("touchEnd", []); await page.waitForTimeout(300);
      if (zoomed) await expect(position).toHaveText(from!); else await expect(position).toHaveText("2 / 4");
    } finally { await context.close(); await env.close(); }
  });

  test("rapid navigation settles on the last selected original", async ({ page }) => {
    await page.setViewportSize({ width: 1360, height: 900 });
    const env = await fixture(page);
    try {
      await env.row.getByRole("button", { name: "第一张", exact: true }).click();
      const viewer = viewerOf(page);
      await decoded(picture(viewer, "第一张"), 1600);
      for (let i = 0; i < 3; i++) await page.keyboard.press("ArrowRight");
      await expect(viewer.getByLabel("图片位置")).toHaveText("4 / 4");
      await decoded(picture(viewer, "全景"), 8000);
      for (let i = 0; i < 3; i++) await page.keyboard.press("ArrowLeft");
      await expect(viewer.getByLabel("图片位置")).toHaveText("1 / 4");
      await decoded(picture(viewer, "第一张"), 1600);
    } finally { await env.close(); }
  });
});
