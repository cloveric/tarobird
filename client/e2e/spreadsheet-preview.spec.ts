import { preparePairing } from "./fixtures/pairing-invite.js";
import { test, expect, type Page } from "@playwright/test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { utils, write } from "xlsx";
import { HubServer } from "../../src/hub/server.js";
import { showDisconnectedBots, enterMobileChat, waitForClientOnline } from "./fixtures/mobile.js";
test.use({ serviceWorkers: "block" });
const title = "表格阅读验收", filename = "分类账本_当前批次.xlsx";
const dialog = (page: Page) => page.getByRole("dialog", { name: "文件预览", exact: true });
function workbook(bookType: "xlsx" | "xls") {
  const book = utils.book_new(), sheet = utils.aoa_to_sheet([["分类账本", "", ""], ["项目", "日期", "金额"], ["交通", 46307, 1234.5], ["合计", "", 1234.5]]);
  sheet["!merges"] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: 2 } }]; sheet.B3.z = "yyyy-mm-dd"; sheet.C3.z = '"¥"#,##0.00'; sheet.C4.f = "SUM(C3:C3)";
  sheet.A101 = { t: "s", v: "第二页明细" }; sheet.AA101 = { t: "s", v: "右侧数据" }; sheet["!ref"] = "A1:AA101";
  utils.book_append_sheet(book, sheet, "支出明细"); utils.book_append_sheet(book, utils.aoa_to_sheet([["分类汇总", "金额"], ["交通费", 1234.5], ['<img src="https://example.com/tracker" onerror="alert(1)">']]), "汇总");
  return Buffer.from(write(book, { bookType, type: "buffer" }));
}
async function fixture(page: Page, run: (bytes: Buffer) => Promise<void>) {
  const root = await mkdtemp(path.join(os.tmpdir(), "spreadsheet-preview-"));
  const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve("dist") });
  try {
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','表格助手','synthetic-spreadsheet')");
    const chat = await hub.store.createConversation("owner", ["alpha"], title, "sheets"), bytes = workbook("xlsx");
    for (const [name, content] of [[filename, bytes], ["历史账本.xls", workbook("xls")], ["损坏.xlsx", Buffer.from("broken")], ["超限.xlsx", Buffer.alloc(10*1024*1024+1)]] as const) {
      const mime = "application/octet-stream";
      const attachmentId = await hub.attachments.importForBot("alpha", { conversationId: chat.id, name, size: content.length, mime, sha256: createHash("sha256").update(content).digest("hex") }, content);
      await hub.store.publishBotMessage("alpha", { conversationId: chat.id, blocks: [{ type: "file", attachmentId, name, mime, size: content.length }], status: "complete" });
    }
    await page.goto(hub.url); await preparePairing(page, hub); await page.getByRole("button", { name: "配对此设备", exact: true }).click();
    await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
    await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" });
    await waitForClientOnline(page); await showDisconnectedBots(page); await enterMobileChat(page, title); await run(bytes);
  } finally { await page.close(); await hub.close(); await rm(root, { recursive: true, force: true }); }
}
async function open(page: Page, name: string) { await page.getByRole("region", { name, exact: true }).getByRole("button", { name: /^预览(?: |$)/ }).click(); await expect(dialog(page)).toBeVisible(); }
for (const width of [1360, 390, 320]) test(`Excel sheets, formats, scrolling and original export (${width}px)`, async ({ page }, info) => {
  await page.setViewportSize({ width, height: 900 }); const requests: string[] = []; page.on("request", request => requests.push(request.url()));
  await fixture(page, async bytes => {
    expect(requests.some(url => /spreadsheet.worker/.test(url))).toBe(false); await open(page, filename);
    await expect(dialog(page).getByRole("cell", { name: "¥1,234.50", exact: true })).toBeVisible();
    await expect(dialog(page).getByRole("cell", { name: "分类账本", exact: true })).toHaveAttribute("colspan", "3");
    await page.screenshot({ path: info.outputPath(`excel-${width}.png`) });
    expect(await dialog(page).locator(".file-preview").evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    const table = dialog(page).getByRole("region", { name: "表格内容" });
    await table.evaluate(el => { el.scrollLeft = el.scrollWidth; }); expect(await table.evaluate(el => el.scrollLeft)).toBeGreaterThan(0);
    await dialog(page).getByRole("button", { name: "下一页", exact: true }).click(); await expect(dialog(page).getByRole("cell", { name: "第二页明细", exact: true })).toBeVisible();
    await dialog(page).getByRole("button", { name: "后面的列", exact: true }).click(); await expect(dialog(page).getByRole("cell", { name: "右侧数据", exact: true })).toBeVisible();
    await dialog(page).getByRole("button", { name: "汇总", exact: true }).click(); await expect(dialog(page).getByRole("cell", { name: "交通费", exact: true })).toBeVisible();
    await expect(dialog(page).locator("img,script,a[href]")).toHaveCount(0);
    const download = page.waitForEvent("download"); await dialog(page).getByRole("button", { name: "另存为", exact: true }).click(); expect(await readFile((await (await download).path())!)).toEqual(bytes);
    await dialog(page).getByRole("button", { name: "关闭", exact: true }).click(); await expect.poll(() => page.workers().filter(worker => /spreadsheet.worker/.test(worker.url())).length).toBe(0);
    await open(page, "历史账本.xls"); await expect(dialog(page).getByRole("cell", { name: "¥1,234.50", exact: true })).toBeVisible();
    expect(requests.every(url => !/^https?:/.test(url) || new URL(url).hostname === "127.0.0.1")).toBe(true);
  });
});
test("broken and oversized workbooks keep save available", async ({ page }) => fixture(page, async () => {
  for (const name of ["损坏.xlsx", "超限.xlsx"]) { await open(page, name); await expect(dialog(page).getByRole("alert")).toContainText(name === "损坏.xlsx" ? "文件可能损坏" : "表格过大"); await expect(dialog(page).getByRole("button", { name: "另存为", exact: true })).toBeEnabled(); await dialog(page).getByRole("button", { name: "关闭", exact: true }).click(); }
}));
test("closing during parser load leaves no stale workbook", async ({ page }) => fixture(page, async () => {
  let release!: () => void; const pending = new Promise<void>(resolve => { release = resolve; });
  await page.route(/spreadsheet\.worker-.*\.js/, async route => { await pending; await route.continue().catch(() => undefined); });
  await open(page, filename); await expect(dialog(page).getByRole("status")).toContainText("正在打开表格"); await dialog(page).getByRole("button", { name: "关闭", exact: true }).click();
  release(); await page.unrouteAll({ behavior: "wait" }); await expect.poll(() => page.workers().filter(worker => /spreadsheet.worker/.test(worker.url())).length).toBe(0);
  await open(page, "损坏.xlsx"); await expect(dialog(page).getByRole("alert")).toContainText("文件可能损坏");
}));
test("unsent phone spreadsheet previews locally and retains the draft", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await fixture(page, async bytes => {
    await page.getByRole("button", { name: "添加附件", exact: true }).click();
    const chooser = page.waitForEvent("filechooser");
    await page.getByRole("dialog", { name: "添加附件", exact: true }).getByRole("button", { name: "上传附件", exact: true }).click();
    await (await chooser).setFiles({ name: "草稿.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", buffer: bytes });
    const tray = page.getByRole("region", { name: "待发送的附件", exact: true });
    await tray.getByRole("button", { name: "预览 草稿.xlsx", exact: true }).click();
    const draft = page.getByRole("dialog", { name: "附件预览", exact: true });
    await expect(draft.getByRole("cell", { name: "¥1,234.50", exact: true })).toBeVisible();
    await draft.getByRole("button", { name: "关闭", exact: true }).click();
    await expect(tray).toContainText("草稿.xlsx");
  });
});
