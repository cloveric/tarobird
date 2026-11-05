import { preparePairing } from "./fixtures/pairing-invite.js";
import { test, expect, type Page } from "@playwright/test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HubServer } from "../../src/hub/server.js";
import { showDisconnectedBots, enterMobileChat, waitForClientOnline } from "./fixtures/mobile.js";

test.use({ serviceWorkers: "block" });
const title = "轻量文档阅读", longName = "长文件名-会议资料与内容整理-手机和桌面直接阅读-Word文档.docx";
const dialog = (page: Page) => page.getByRole("dialog", { name: "文件预览", exact: true });
async function fixture(page: Page, run: () => Promise<void>) {
  const root = await mkdtemp(path.join(os.tmpdir(), "document-preview-"));
  const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve("dist") });
  try {
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','阅读助手','synthetic-document-preview')");
    const chat = await hub.store.createConversation("owner", ["alpha"], title, "documents");
    for (const name of [longName, "reading.md", "broken.docx", "large.docx", "legacy.doc"]) {
      const bytes = name === longName ? await readFile("e2e/fixtures/documents/reading.docx") : name === "reading.md" ? await readFile("e2e/fixtures/documents/reading.md") : name === "large.docx" ? Buffer.alloc(10 * 1024 * 1024 + 1) : Buffer.from("broken fixture");
      const mime = name.endsWith("md") ? "text/markdown" : "application/octet-stream";
      const attachmentId = await hub.attachments.importForBot("alpha", { conversationId: chat.id, name, size: bytes.length, mime, sha256: createHash("sha256").update(bytes).digest("hex") }, bytes);
      await hub.store.publishBotMessage("alpha", { conversationId: chat.id, blocks: [{ type: "file", attachmentId, name, mime, size: bytes.length }], status: "complete" });
    }
    await page.goto(hub.url); await preparePairing(page, hub); await page.getByRole("button", { name: "配对此设备", exact: true }).click();
    await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
    await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" });
    await waitForClientOnline(page); await showDisconnectedBots(page); await enterMobileChat(page, title); await run();
  } finally { await page.close(); await hub.close(); await rm(root, { recursive: true, force: true }); }
}
async function open(page: Page, name: string) {
  await page.getByRole("region", { name, exact: true }).getByRole("button", { name: /^预览(?: |$)/ }).click();
  await expect(dialog(page)).toBeVisible();
}
for (const width of [1360, 390, 320]) test(`Word and Markdown read locally, preserve bytes and release workers (${width}px)`, async ({ page }, info) => {
  await page.setViewportSize({ width, height: 900 });
  const requests: string[] = []; page.on("request", request => requests.push(request.url()));
  await fixture(page, async () => {
    expect(requests.some(url => /docx.worker/.test(url))).toBe(false);
    const before = Date.now(); await open(page, longName);
    await expect(dialog(page).getByRole("heading", { name: "文档阅读预览", exact: true })).toBeVisible();
    await info.attach("first-render", { contentType: "application/json", body: JSON.stringify({ width, milliseconds: Date.now() - before }) });
    await expect(dialog(page).locator("li")).toHaveCount(2); await expect(dialog(page).getByRole("table")).toContainText("附件预览与阅读体验");
    await expect.poll(() => dialog(page).locator("img").evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0)).toBe(true);
    await expect(dialog(page).getByText("Unsafe link", { exact: true })).not.toHaveAttribute("href");
    await expect(dialog(page).getByRole("link", { name: "项目主页" })).toHaveAttribute("rel", "noopener noreferrer");
    expect(page.workers().filter(worker => /docx.worker/.test(worker.url()))).toHaveLength(0);
    await dialog(page).getByRole("region", { name: "文档内容" }).evaluate(el => { el.scrollTop = el.scrollHeight; });
    await expect(dialog(page).getByText(/阅读笔记 50：/)).toBeVisible();
    await dialog(page).getByRole("region", { name: "文档内容" }).evaluate(el => { el.scrollTop = 0; });
    await page.screenshot({ path: info.outputPath(`word-${width}.png`) });
    const download = page.waitForEvent("download"); await dialog(page).getByRole("button", { name: "另存为", exact: true }).click();
    expect(await readFile((await (await download).path())!)).toEqual(await readFile("e2e/fixtures/documents/reading.docx"));
    await dialog(page).getByRole("button", { name: "关闭", exact: true }).click();
    await expect(page.getByRole("region", { name: longName, exact: true }).getByRole("button", { name: /^预览(?: |$)/ })).toBeFocused();
    await open(page, "reading.md");
    await expect(dialog(page).getByRole("heading", { name: "Markdown 阅读预览" })).toBeVisible();
    await expect(dialog(page).locator("pre code")).toContainText("const ready = true;");
    await expect(dialog(page).getByRole("table")).toContainText("可阅读");
    await expect(dialog(page).locator("img,script")).toHaveCount(0);
    expect(await page.evaluate(() => (window as any).pwned)).toBeUndefined();
    expect(requests.every(url => !/^https?:/.test(url) || new URL(url).hostname === "127.0.0.1")).toBe(true);
    expect(await dialog(page).locator(".file-preview").evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath(`markdown-${width}.png`) });
    await page.keyboard.press("Escape"); await expect(dialog(page)).toHaveCount(0);
  });
});
test("damaged, oversized and legacy Word retain an actionable fallback and original download", async ({ page }) => {
  await fixture(page, async () => {
    for (const name of ["broken.docx", "large.docx", "legacy.doc"]) {
      await open(page, name);
      await expect(dialog(page)).toContainText(name === "broken.docx" ? "可能损坏或已加密" : name === "large.docx" ? "文档过大" : "不支持内置预览");
      await expect(dialog(page).getByRole("button", { name: "另存为", exact: true })).toBeEnabled();
      await dialog(page).getByRole("button", { name: "关闭", exact: true }).click();
    }
  });
});
test("closing while the Word worker loads leaves no background parser or stale document", async ({ page }) => {
  await fixture(page, async () => {
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    await page.route(/docx\.worker-.*\.js/, async route => { await pending; await route.continue().catch(() => undefined); });
    await open(page, longName);
    await expect(dialog(page).getByRole("status")).toContainText("正在打开文档");
    await dialog(page).getByRole("button", { name: "关闭", exact: true }).click();
    release(); await page.unrouteAll({ behavior: "wait" });
    await expect(dialog(page)).toHaveCount(0);
    await expect.poll(() => page.workers().filter(worker => /docx.worker/.test(worker.url())).length).toBe(0);
    await open(page, "reading.md");
    await expect(dialog(page).getByRole("heading", { name: "Markdown 阅读预览" })).toBeVisible();
    await expect(dialog(page).getByText("本周计划", { exact: true })).toHaveCount(0);
  });
});
