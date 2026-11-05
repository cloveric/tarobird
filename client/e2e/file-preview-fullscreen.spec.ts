import { preparePairing } from "./fixtures/pairing-invite.js";
import { test, expect, type Locator, type Page } from "@playwright/test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HubServer } from "../../src/hub/server.js";
import { showDisconnectedBots, enterMobileChat, waitForClientOnline } from "./fixtures/mobile.js";

test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, serviceWorkers: "block" });
const wordName = "手机阅读-" + "很长的文件名称与原始资料-".repeat(5) + ".docx";
type Bounds = { top: number; left: number; right: number; bottom: number };
async function insets(page: Page, top: number, right: number, bottom: number, left: number) {
  await page.evaluate(values => {
    for (const [side, value] of Object.entries(values)) document.documentElement.style.setProperty(`--safe-area-inset-${side}`, `${value}px`);
  }, { top, right, bottom, left });
}
async function fills(preview: Locator, bounds: Bounds) {
  await expect.poll(() => preview.locator(".file-preview").evaluate((node, b) => {
    const r = node.getBoundingClientRect();
    return Math.abs(r.top - b.top) < 1 && Math.abs(r.bottom - b.bottom) < 1 && Math.abs(r.left - b.left) < 1 && Math.abs(r.right - b.right) < 1;
  }, bounds)).toBe(true);
  expect(await preview.locator(".file-preview").evaluate(node => node.scrollWidth <= node.clientWidth && node.scrollHeight <= node.clientHeight)).toBe(true);
  expect(await preview.getByRole("button", { name: "关闭", exact: true }).evaluate((node, b) => {
    const r = node.getBoundingClientRect();
    return r.top >= b.top && r.left >= b.left && r.bottom <= b.bottom && r.right <= b.right && r.height >= 44;
  }, bounds)).toBe(true);
}

// Real document readers and Hub. Insets and the native header are simulated;
// these assertions do not certify a physical cutout or OS file chooser.
for (const native of [false, true]) test(`phone readers fill safe bounds across rotation, keyboard and drafts (${native ? "native header" : "browser header"})`, async ({ page }, info) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "file-fullscreen-"));
  const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve("dist") });
  try {
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('reader','阅读助手','fixture')");
    const chat = await hub.store.createConversation("owner", ["reader"], "全屏阅读", "reading");
    for (const [name, bytes, mime] of [
      [wordName, await readFile("e2e/fixtures/documents/reading.docx"), "application/octet-stream"],
      ["reading.pdf", await readFile("e2e/fixtures/pdf/reading.pdf"), "application/pdf"],
      ["notes.txt", Buffer.from("纯文本全屏阅读\n".repeat(100)), "text/plain"],
    ] as const) {
      const attachmentId = await hub.attachments.importForBot("reader", { conversationId: chat.id, name, mime, size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") }, bytes);
      await hub.store.publishBotMessage("reader", { conversationId: chat.id, blocks: [{ type: "file", attachmentId, name, mime, size: bytes.length }], status: "complete" });
    }
    await page.goto(hub.url);
    await preparePairing(page, hub); await page.getByRole("button", { name: "配对此设备", exact: true }).click();
    await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
    await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" });
    await waitForClientOnline(page); await showDisconnectedBots(page); await enterMobileChat(page, chat.title);
    if (native) await page.evaluate(() => { (window as any).androidBridge = {}; });
    await insets(page, 59, 0, 34, 0);
    const portrait = { top: 59, left: 0, right: 390, bottom: 810 };
    const preview = page.getByRole("dialog", { name: "文件预览", exact: true });
    const word = page.getByRole("region", { name: wordName, exact: true }).getByRole("button", { name: `预览 ${wordName}`, exact: true });
    await word.click();
    await expect(preview.getByRole("heading", { name: "文档阅读预览", exact: true })).toBeVisible();
    await fills(preview, portrait);
    const header = preview.locator(".file-preview > header"), content = preview.getByRole("region", { name: "文档内容", exact: true });
    const before = await header.boundingBox();
    expect((await content.boundingBox())!.height).toBeGreaterThan(500);
    await content.evaluate(node => { node.scrollTop = node.scrollHeight; });
    await expect(preview.getByText(/阅读笔记 50：/)).toBeVisible();
    expect(await header.boundingBox()).toEqual(before);
    await content.evaluate(node => { node.scrollTop = 0; });
    await page.screenshot({ path: info.outputPath("word-safe-portrait.png") });
    await page.setViewportSize({ width: 844, height: 390 }); await insets(page, 0, 44, 21, 44);
    await fills(preview, { top: 0, left: 44, right: 800, bottom: 369 });
    expect((await content.boundingBox())!.height).toBeGreaterThan(180);
    await page.screenshot({ path: info.outputPath("word-safe-landscape.png") });
    await preview.getByRole("button", { name: "关闭", exact: true }).click();

    await page.setViewportSize({ width: 390, height: 844 }); await insets(page, 59, 0, 34, 0);
    await page.getByRole("region", { name: "reading.pdf", exact: true }).getByRole("button", { name: "预览 reading.pdf", exact: true }).click();
    await expect(preview.getByText("PAGE_1_CONTENT", { exact: true })).toBeVisible();
    await fills(preview, portrait);
    expect((await preview.locator(".pdf-reader-stage").boundingBox())!.height).toBeGreaterThan(450);
    await preview.getByRole("button", { name: "下一页", exact: true }).click();
    await expect(preview.getByText("PAGE_2_CONTENT", { exact: true })).toBeVisible();
    await page.screenshot({ path: info.outputPath("pdf-safe-portrait.png") });
    await page.setViewportSize({ width: 844, height: 390 }); await insets(page, 0, 44, 21, 44);
    await fills(preview, { top: 0, left: 44, right: 800, bottom: 369 });
    expect((await preview.locator(".pdf-reader-stage").boundingBox())!.height).toBeGreaterThan(150);
    const bar = (await preview.locator(".pdf-reader-bar").boundingBox())!;
    expect(bar.y + bar.height).toBeLessThanOrEqual(369);
    // Native Back dismisses this reader, not the conversation underneath it.
    expect(await page.evaluate(() => !window.dispatchEvent(new Event("tarocub-native-back", { cancelable: true })))).toBe(true);
    await expect(preview).toHaveCount(0);

    await page.setViewportSize({ width: 390, height: 844 });
    await insets(page, 59, 0, 34, 0);
    if (native) await page.evaluate(() => { document.documentElement.dataset.nativeInsets = "android"; });
    await page.getByRole("region", { name: "notes.txt", exact: true }).getByRole("button", { name: "预览 notes.txt", exact: true }).click();
    await fills(preview, native ? { top: 0, left: 0, right: 390, bottom: 844 } : portrait);
    await page.keyboard.press("Escape");
    await expect(preview).toHaveCount(0);
    if (native) await page.evaluate(() => { delete document.documentElement.dataset.nativeInsets; });

    // The same layout is used before sending, without uploading the draft.
    await page.getByRole("textbox", { name: "消息", exact: true }).fill("保留草稿");
    await page.locator('input[type="file"][multiple]').setInputFiles({ name: "draft.md", mimeType: "text/markdown", buffer: Buffer.from("# 草稿全屏阅读\n" + "阅读内容\n\n".repeat(80)) });
    const draftButton = page.getByRole("button", { name: "预览 draft.md", exact: true });
    await draftButton.click();
    const draft = page.getByRole("dialog", { name: "附件预览", exact: true });
    await expect(draft.getByRole("heading", { name: "草稿全屏阅读", exact: true })).toBeVisible();
    await fills(draft, portrait);
    // Visual-viewport keyboard band: no controls slip under the keyboard.
    await page.evaluate(() => {
      const root = document.documentElement;
      root.dataset.keyboardOpen = "true";
      root.style.setProperty("--app-height", "400px"); root.style.setProperty("--app-top", "12px");
    });
    await fills(draft, { top: 71, left: 0, right: 390, bottom: 412 });
    await page.evaluate(() => {
      const root = document.documentElement;
      root.dataset.keyboardOpen = "false"; root.style.removeProperty("--app-height"); root.style.removeProperty("--app-top");
    });
    await fills(draft, portrait);
    await draft.getByRole("button", { name: "关闭", exact: true }).click();
    await expect(draftButton).toBeFocused();
    await expect(page.getByRole("textbox", { name: "消息", exact: true })).toHaveValue("保留草稿");
    expect((await hub.store.snapshot("owner", chat.id)).messages).toHaveLength(3);
  } finally { await page.close(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});
