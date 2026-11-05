import { preparePairing } from "./fixtures/pairing-invite.js";
import { test, expect, type Page } from "@playwright/test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HubServer } from "../../src/hub/server.js";
import { showDisconnectedBots, enterMobileChat, waitForClientOnline } from "./fixtures/mobile.js";

test.use({ serviceWorkers: "block" });
const title = "文档阅读验收";
const preview = (page: Page) => page.getByRole("dialog", { name: "文件预览", exact: true });
async function fixture(page: Page, run: (hub: HubServer) => Promise<void>) {
  const root = await mkdtemp(path.join(os.tmpdir(), "pdf-preview-"));
  const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve("dist") });
  try {
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','阅读助手','synthetic-pdf-preview')");
    const chat = await hub.store.createConversation("owner", ["alpha"], title, "pdf");
    for (const name of ["reading.pdf", "locked.pdf", "broken.pdf", "actions.pdf", "selection.txt"]) {
      const bytes = name.endsWith("txt") ? Buffer.from("Select this text and release outside the preview. The document must remain open.") : await readFile(path.resolve("e2e/fixtures/pdf", name));
      const mime = name.endsWith("txt") ? "text/plain" : "application/pdf";
      const attachmentId = await hub.attachments.importForBot("alpha", { conversationId: chat.id, name, size: bytes.length, mime, sha256: createHash("sha256").update(bytes).digest("hex") }, bytes);
      await hub.store.publishBotMessage("alpha", { conversationId: chat.id, blocks: [{ type: "file", attachmentId, name, mime, size: bytes.length }], status: "complete" });
    }
    await page.goto(hub.url); await preparePairing(page, hub); await page.getByRole("button", { name: "配对此设备", exact: true }).click();
    await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
    await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" });
    await waitForClientOnline(page); await showDisconnectedBots(page); await enterMobileChat(page, title); await run(hub);
  } finally { await page.close(); await hub.close(); await rm(root, { recursive: true, force: true }); }
}
async function open(page: Page, name: string) {
  await page.getByRole("region", { name, exact: true }).getByRole("button", { name: /^预览(?: |$)/ }).click();
  await expect(preview(page)).toBeVisible();
}
async function expectPaint(page: Page, color: "red" | "blue") {
  await expect.poll(() => preview(page).locator("canvas").evaluateAll((canvases, target) => {
    if (canvases.length !== 1) return false;
    const canvas = canvases[0] as HTMLCanvasElement, ctx = canvas.getContext("2d");
    if (!ctx || !canvas.width || !canvas.height) return false;
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let colored = 0;
    for (let i = 0; i < data.length; i += 16) if (data[i + 3] > 200 && (target === "red" ? data[i]! > data[i + 2]! + 60 : data[i + 2]! > data[i]! + 60)) colored++;
    return colored > 100;
  }, color)).toBe(true);
}

for (const width of [1360, 390, 320]) test(`PDF paints actual pages, selects text, navigates and saves original bytes (${width}px)`, async ({ page }, info) => {
  await page.setViewportSize({ width, height: 900 });
  await fixture(page, async () => {
    const requests: string[] = [], errors: string[] = [];
    page.on("request", r => { requests.push(r.url()); }); page.on("pageerror", e => errors.push(e.message));
    const openedAt = Date.now(); await open(page, "reading.pdf");
    await expect(preview(page).getByText("PAGE_1_CONTENT", { exact: true })).toBeVisible({ timeout: 5000 });
    await expectPaint(page, "red");
    await expect(preview(page).getByText("阅读空间：预览、翻页与文字选择", { exact: true })).toBeVisible();
    await info.attach("pdf-first-page", { contentType: "application/json", body: JSON.stringify({ width, readyMs: Date.now() - openedAt, surface: "local browser, service worker blocked, synthetic 2-page PDF" }) });
    await page.screenshot({ path: info.outputPath(`page-one-${width}.png`) });
    await preview(page).getByRole("button", { name: "下一页", exact: true }).click();
    await expect(preview(page).getByText("PAGE_2_CONTENT", { exact: true })).toBeVisible(); await expectPaint(page, "blue");
    await expect(preview(page).getByText("PAGE_1_CONTENT", { exact: true })).toHaveCount(0);
    const canvas = preview(page).locator("canvas"), before = await canvas.boundingBox();
    if (width <= 390) await preview(page).getByRole("combobox", { name: "缩放", exact: true }).selectOption("1.5");
    else await preview(page).getByRole("button", { name: "放大", exact: true }).click();
    await expect.poll(async () => (await canvas.boundingBox())!.width).toBeGreaterThan(before!.width);
    await preview(page).getByRole("combobox", { name: "缩放", exact: true }).selectOption("fit");
    await expectPaint(page, "blue");
    const download = page.waitForEvent("download"); await preview(page).getByRole("button", { name: "另存为", exact: true }).click();
    const downloaded = await download; expect(await readFile((await downloaded.path())!)).toEqual(await readFile(path.resolve("e2e/fixtures/pdf/reading.pdf")));
    await preview(page).getByRole("button", { name: "关闭", exact: true }).click();
    await expect(page.getByRole("region", { name: "reading.pdf", exact: true }).getByRole("button", { name: /^预览(?: |$)/ })).toBeFocused();
    expect(requests.every(url => !/^https?:/.test(url) || new URL(url).hostname === "127.0.0.1")).toBe(true);
    expect(errors).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
});

test("dragging selected preview text outside does not dismiss, while an outside click does", async ({ page }, info) => {
  await fixture(page, async () => {
    await open(page, "selection.txt");
    const text = await preview(page).locator("pre").boundingBox(), box = await preview(page).locator("section").boundingBox();
    await page.mouse.move(text!.x + 16, text!.y + 15); await page.mouse.down();
    await page.mouse.move(box!.x - 20, text!.y + 50, { steps: 5 }); await page.mouse.up();
    await expect(preview(page)).toBeVisible();
    await page.screenshot({ path: info.outputPath("selection-remains-open.png") });
    await page.mouse.click(box!.x - 20, box!.y + 50);
    await expect(preview(page)).toHaveCount(0);
  });
});

test("a damaged PDF has useful feedback and remains downloadable", async ({ page }) => {
  await fixture(page, async () => {
    await open(page, "broken.pdf");
    await expect(preview(page).getByRole("alert")).toContainText(/PDF|文档/);
    await expect(preview(page).getByRole("button", { name: "另存为", exact: true })).toBeEnabled();
    const received = page.waitForEvent("download"); await preview(page).getByRole("button", { name: "另存为", exact: true }).click();
    expect(await readFile((await (await received).path())!)).toEqual(await readFile(path.resolve("e2e/fixtures/pdf/broken.pdf")));
    await preview(page).getByRole("button", { name: "关闭", exact: true }).click(); await expect(preview(page)).toHaveCount(0);
  });
});

test("PDF actions do not execute and closing from document content releases its worker", async ({ page }) => {
  await fixture(page, async () => {
    const external: string[] = [], dialogs: string[] = [];
    await page.route("https://pdf-preview.invalid/**", async route => { external.push(route.request().url()); await route.abort(); });
    page.on("dialog", async dialog => { dialogs.push(dialog.message()); await dialog.dismiss(); });
    await open(page, "actions.pdf");
    await expect(preview(page).getByText("PAGE_1_CONTENT", { exact: true })).toBeVisible(); await expectPaint(page, "red");
    await preview(page).getByText("PAGE_1_CONTENT", { exact: true }).dblclick();
    await expect.poll(() => page.evaluate(() => getSelection()?.toString())).toContain("PAGE_1_CONTENT");
    expect(page.workers().filter(worker => /pdf\.worker/.test(worker.url()))).toHaveLength(1);
    await page.keyboard.press("Escape"); await expect(preview(page)).toHaveCount(0);
    await expect.poll(() => page.workers().filter(worker => /pdf\.worker/.test(worker.url())).length).toBe(0);
    expect(external).toEqual([]); expect(dialogs).toEqual([]);
  });
});

test("encrypted PDFs accept a password without persisting it", async ({ page }) => {
  await fixture(page, async () => {
    await open(page, "locked.pdf");
    const password = preview(page).locator('input[type="password"]'); await expect(password).toBeVisible();
    await password.fill("wrong-password"); await password.press("Enter");
    await expect(preview(page).getByRole("alert")).toContainText(/密码/);
    await password.fill("reading-acceptance"); await password.press("Enter");
    await expect(preview(page).getByText("PAGE_1_CONTENT", { exact: true })).toBeVisible(); await expectPaint(page, "red");
    await preview(page).getByRole("button", { name: "关闭", exact: true }).click();
    await expect.poll(() => page.workers().filter(worker => /pdf\.worker/.test(worker.url())).length).toBe(0);
    await open(page, "locked.pdf"); await expect(password).toHaveValue("");
    expect(await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }))).not.toContain("reading-acceptance");
  });
});

test("rapid navigation, zoom and resize preserve the final page and release earlier renders", async ({ page }) => {
  await fixture(page, async () => {
    const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
    await open(page, "reading.pdf"); await expectPaint(page, "red");
    for (let i = 0; i < 3; i++) {
      await preview(page).getByRole("button", { name: "下一页", exact: true }).click();
      await preview(page).getByRole("button", { name: "放大", exact: true }).click();
      await preview(page).getByRole("button", { name: "上一页", exact: true }).click();
      await preview(page).getByRole("combobox", { name: "缩放", exact: true }).selectOption("fit");
    }
    await preview(page).getByRole("combobox", { name: "缩放", exact: true }).selectOption("4");
    await expect.poll(() => preview(page).locator("canvas").evaluate(canvas => canvas.width * canvas.height)).toBeGreaterThan(8_000_000);
    expect(await preview(page).locator("canvas").evaluate(canvas => canvas.width * canvas.height)).toBeLessThanOrEqual(8 * 1024 * 1024);
    await preview(page).getByRole("combobox", { name: "缩放", exact: true }).selectOption("fit");
    await page.setViewportSize({ width: 390, height: 844 });
    await preview(page).getByRole("button", { name: "下一页", exact: true }).click();
    await expect(preview(page).getByText("PAGE_2_CONTENT", { exact: true })).toBeVisible(); await expectPaint(page, "blue");
    expect(await preview(page).locator("canvas").evaluate(canvas => canvas.width * canvas.height)).toBeLessThanOrEqual(8 * 1024 * 1024);
    expect(await preview(page).locator("canvas").evaluate(canvas => canvas.getBoundingClientRect().width)).toBeLessThan(390);
    await preview(page).getByRole("button", { name: "关闭", exact: true }).click();
    await expect.poll(() => page.workers().filter(worker => /pdf\.worker/.test(worker.url())).length).toBe(0);
    expect(errors).toEqual([]);
  });
});

test("a failed worker gives a retryable error instead of hanging or parsing on the main thread", async ({ page }) => {
  await fixture(page, async () => {
    let fail = true;
    await page.route(/\/assets\/pdf\.worker[^/]+\.mjs$/, async route => {
      if (fail) await route.fulfill({ status: 200, contentType: "text/javascript", body: 'throw new Error("synthetic worker failure")' });
      else await route.continue();
    });
    await open(page, "reading.pdf");
    await expect(preview(page).getByRole("alert")).toContainText("读取 PDF 时出错");
    await expect(preview(page).getByRole("button", { name: "另存为", exact: true })).toBeEnabled();
    await expect.poll(() => page.workers().filter(worker => /pdf\.worker/.test(worker.url())).length).toBe(0);
    fail = false;
    await preview(page).getByRole("button", { name: "重试", exact: true }).click();
    await expectPaint(page, "red");
    await expect(preview(page).getByText("PAGE_1_CONTENT", { exact: true })).toBeVisible();
  });
});

test("the narrow dark English reader keeps controls reachable and document text unchanged", async ({ page }, info) => {
  await page.setViewportSize({ width: 320, height: 844 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await fixture(page, async () => {
    const { openSettings, closeSettings } = await import("./fixtures/settings.js");
    const { mobileHome } = await import("./fixtures/mobile.js");
    await openSettings(page);
    await page.locator("#theme").selectOption("dark"); await page.locator("#language").selectOption("en");
    await closeSettings(page, true);
    await mobileHome(page).getByRole("navigation", { name: "Main navigation" }).getByRole("button", { name: /^Message/ }).click();
    await enterMobileChat(page, title);
    await page.getByRole("region", { name: "reading.pdf", exact: true }).getByRole("button", { name: "Preview reading.pdf", exact: true }).click();
    const reader = page.getByRole("dialog", { name: "File preview", exact: true });
    await expect(reader.getByText("阅读空间：预览、翻页与文字选择", { exact: true })).toBeVisible();
    await expect(reader.getByRole("combobox", { name: "Zoom", exact: true })).toBeVisible();
    const controls = await reader.locator(".pdf-reader-bar button:visible,.pdf-reader-bar input:visible,.pdf-reader-bar select:visible").evaluateAll(elements => elements.map(element => { const r = element.getBoundingClientRect(); return { width: r.width, height: r.height, left: r.left, right: r.right }; }));
    expect(controls.every(r => r.width >= 44 && r.height >= 44 && r.left >= 0 && r.right <= 320)).toBe(true);
    await page.screenshot({ path: info.outputPath("dark-english-320.png") });
    await reader.getByRole("button", { name: "Close", exact: true }).click();
  });
});

test("closing during worker startup releases the worker and restores the file action", async ({ page }) => {
  let release: () => void = () => undefined;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  try {
    await fixture(page, async () => {
      let started = false;
      await page.route(/\/assets\/pdf\.worker[^/]+\.mjs$/, async route => { started = true; await barrier; await route.continue(); });
      await open(page, "reading.pdf"); await expect.poll(() => started).toBe(true);
      await preview(page).getByRole("button", { name: "关闭", exact: true }).click();
      await expect(preview(page)).toHaveCount(0);
      await expect.poll(() => page.workers().filter(worker => /pdf\.worker/.test(worker.url())).length).toBe(0);
      release();
      await expect(page.getByRole("region", { name: "reading.pdf", exact: true }).getByRole("button", { name: /^预览(?: |$)/ })).toBeFocused();
    });
  } finally { release(); }
});

test.describe("cached local reader", () => {
  test.use({ serviceWorkers: "allow" });
  test("a downloaded PDF renders new pages after the Hub has stopped and the page reloads", async ({ page }) => {
    await fixture(page, async hub => {
      await open(page, "reading.pdf"); await expectPaint(page, "red");
      await preview(page).getByRole("button", { name: "关闭", exact: true }).click();
      await page.evaluate(() => navigator.serviceWorker.ready.then(() => undefined));
      await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
      await hub.close();
      await page.reload({ waitUntil: "domcontentloaded" });
      await expect(page.locator(".offline-banner")).toBeVisible();
      await open(page, "reading.pdf"); await expectPaint(page, "red");
      await preview(page).getByRole("button", { name: "下一页", exact: true }).click();
      await expect(preview(page).getByText("PAGE_2_CONTENT", { exact: true })).toBeVisible();
      await expectPaint(page, "blue");
    });
  });
});
