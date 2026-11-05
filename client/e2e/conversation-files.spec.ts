import { preparePairing } from "./fixtures/pairing-invite.js";
import { test, expect, type Page } from "@playwright/test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HubServer } from "../../src/hub/server.js";
import { showDisconnectedBots, selectConversation, waitForClientOnline } from "./fixtures/mobile.js";

test.use({ serviceWorkers: "block" });

const panel = (page: Page) => page.getByRole("dialog", { name: "对话文件", exact: true });
const rows = (page: Page) => panel(page).locator(".conversation-file-row");
async function pair(page: Page, hub: HubServer) {
  await page.goto(hub.url); await preparePairing(page, hub); await page.getByRole("button", { name: "配对此设备", exact: true }).click();
  await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
  await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" }); await waitForClientOnline(page); await showDisconnectedBots(page);
}
async function openFiles(page: Page) {
  await page.getByRole("button", { name: "更多聊天操作", exact: true }).click();
  await page.getByRole("button", { name: "文件", exact: true }).click(); await expect(panel(page)).toBeVisible();
}
async function share(hub: HubServer, conversationId: string, name: string, bytes: Buffer, mime = "text/markdown", botId = "alpha") {
  const attachmentId = await hub.attachments.importForBot(botId, { conversationId, name, size: bytes.length, mime, sha256: createHash("sha256").update(bytes).digest("hex") }, bytes);
  return hub.store.publishBotMessage(botId, { conversationId, blocks: [{ type: "file", attachmentId, name, size: bytes.length, mime }] });
}

for (const width of [1360, 390]) test(`conversation files open, search, preview, save and locate across Bot conversations (${width}px)`, async ({ browser }, info) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "chat-files-ui-"));
  const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve("dist") });
  const context = await browser.newContext({ viewport: { width, height: 900 }, isMobile: width < 760, hasTouch: width < 760, serviceWorkers: "block" });
  const page = await context.newPage(), errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  try {
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','研究助手','fixture'),('beta','其他助手','fixture')");
    const current = await hub.store.createConversation("owner", ["alpha"], "项目资料", "current");
    const older = await hub.store.createConversation("owner", ["alpha"], "会议记录", "older");
    const other = await hub.store.createConversation("owner", ["beta"], "其他项目", "other");
    const md = Buffer.from("# 项目摘要\n\n这份文件来自当前对话。"), docx = await readFile("e2e/fixtures/documents/reading.docx");
    await share(hub, current.id, "项目摘要.md", md);
    await share(hub, current.id, "会议资料与内容整理-Word文档.docx", docx, "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    await share(hub, current.id, "设计图片.png", Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64"), "image/png");
    const previous = await share(hub, older.id, "历史资料.md", Buffer.from("# 历史资料"));
    await share(hub, other.id, "其他Bot专用.md", md, "text/markdown", "beta");
    await pair(page, hub); await selectConversation(page, "项目资料");
    await page.getByRole("textbox", { name: "消息", exact: true }).fill("保留我的草稿");
    await openFiles(page); await expect(rows(page)).toHaveCount(3);
    await expect(panel(page).getByLabel("文件范围", { exact: true })).toHaveValue("");
    await expect(panel(page)).not.toContainText("历史资料.md"); await expect(panel(page)).not.toContainText("其他Bot专用.md");
    await page.screenshot({ path: info.outputPath(`files-${width}.png`), animations: "disabled" });
    expect(await panel(page).evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
    for (const [name, content] of [["项目摘要.md", "这份文件来自当前对话。"], ["会议资料与内容整理-Word文档.docx", "文档阅读预览"]]) {
      await panel(page).getByRole("button", { name: `预览 ${name}`, exact: true }).click();
      const preview = page.getByRole("dialog", { name: "文件预览", exact: true });
      await expect(preview).toContainText(content!);
      const downloading = page.waitForEvent("download"); await preview.getByRole("button", { name: "另存为", exact: true }).click();
      expect(await readFile((await (await downloading).path())!)).toEqual(name!.endsWith("md") ? md : docx);
      await preview.getByRole("button", { name: "关闭", exact: true }).click();
      await expect(panel(page)).toBeVisible(); await expect(panel(page).getByRole("button", { name: `预览 ${name}`, exact: true })).toBeFocused();
    }
    await panel(page).getByRole("button", { name: "预览 设计图片.png", exact: true }).click();
    // Image files use the shared image viewer; other documents keep FilePreview.
    const preview = page.getByRole("dialog", { name: "图片预览", exact: true });
    await expect.poll(() => preview.locator("img").evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(1);
    await page.keyboard.press("Escape"); await expect(preview).toHaveCount(0); await expect(panel(page)).toBeVisible();
    await panel(page).getByLabel("文件范围", { exact: true }).selectOption("alpha"); await expect(rows(page)).toHaveCount(4);
    await expect(panel(page)).not.toContainText("其他Bot专用.md");
    await panel(page).getByRole("searchbox", { name: "搜索对话文件", exact: true }).fill("历史");
    await panel(page).getByRole("button", { name: "搜索", exact: true }).click(); await expect(rows(page)).toHaveCount(1);
    await panel(page).getByRole("button", { name: "查看 历史资料.md 的原消息", exact: true }).click();
    await expect(panel(page)).toHaveCount(0); await expect(page.getByRole("heading", { name: "会议记录", exact: true, level: 1 })).toBeVisible();
    await expect(page.locator(`[data-message-id="${previous.id}"].focused-message`)).toBeVisible();
    await selectConversation(page, "项目资料"); await expect(page.getByRole("textbox", { name: "消息", exact: true })).toHaveValue("保留我的草稿");
    await openFiles(page); await expect(rows(page)).toHaveCount(3);
    await panel(page).getByRole("searchbox", { name: "搜索对话文件", exact: true }).fill("找不到");
    await panel(page).getByRole("button", { name: "搜索", exact: true }).click();
    await expect(panel(page)).toContainText("没有匹配的文件"); await expect(rows(page)).toHaveCount(0);
    await panel(page).getByRole("button", { name: "关闭对话文件", exact: true }).click();
    expect(errors).toEqual([]);
  } finally { await context.close(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});

test("file paging retains rows on failure, retries, and ignores a superseded search", async ({ page }) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "chat-files-pages-")); const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve("dist") });
  let release: (() => void) | undefined;
  try {
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','研究助手','fixture')");
    const chat = await hub.store.createConversation("owner", ["alpha"], "分页资料", "pages");
    for (let i = 0; i < 53; i++) await share(hub, chat.id, `资料${i}.md`, Buffer.from("# 内容"));
    await pair(page, hub); await openFiles(page); await expect(rows(page)).toHaveCount(50);
    let fail = true;
    await page.route(url => url.pathname === "/api/conversation-files" && url.searchParams.has("cursor"), async route => {
      if (fail) { await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "fixture_unavailable" }) }); }
      else await route.continue();
    });
    await panel(page).getByRole("button", { name: "下一页", exact: true }).click();
    await expect(panel(page).getByRole("alert")).toContainText("文件列表加载失败"); await expect(rows(page)).toHaveCount(50); fail = false;
    await panel(page).getByRole("button", { name: "重试", exact: true }).click(); await expect(rows(page)).toHaveCount(3);
    await panel(page).getByRole("button", { name: "上一页", exact: true }).click(); await expect(rows(page)).toHaveCount(50);
    let entered!: () => void; const ready = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
    await page.route(url => url.pathname === "/api/conversation-files" && url.searchParams.get("q") === "资料1", async route => {
      const response = await route.fetch(); entered(); await gate; await route.fulfill({ response }).catch(() => {});
    });
    const search = panel(page).getByRole("searchbox", { name: "搜索对话文件", exact: true });
    await search.fill("资料1"); await panel(page).getByRole("button", { name: "搜索", exact: true }).click(); await ready;
    await search.fill("资料52"); await panel(page).getByRole("button", { name: "搜索", exact: true }).click(); await expect(rows(page)).toHaveCount(1);
    release!(); await page.unrouteAll({ behavior: "wait" }); await expect(rows(page)).toHaveCount(1); await expect(rows(page)).toContainText("资料52.md");
  } finally { release?.(); await page.close(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});
