import { test, expect, type Page } from "@playwright/test";
import { access } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { imageViewerFixture } from "./fixtures/image-viewer.js";
import { openWorkspacePage, waitForClientOnline } from "./fixtures/mobile.js";

const blob = (directory: string, id: string) => access(path.join(directory, `${id}.blob`)).then(() => true, () => false);
const idOf = async (hub: Awaited<ReturnType<typeof imageViewerFixture>>["hub"], name: string) => (await hub.store.db.get<{ id: string }>("SELECT id FROM attachments WHERE name=?", [name]))!.id;
async function english(page: Page) {
  await page.evaluate(() => new Promise<void>((resolve, reject) => {
    const open = indexedDB.open("tarocub-hosts-v1");
    open.onerror = () => reject(open.error);
    open.onsuccess = () => { const db = open.result, tx = db.transaction("meta", "readwrite"), store = tx.objectStore("meta"), get = store.get("preferences");
      get.onsuccess = () => { const value = get.result ? JSON.parse(get.result) : {}; store.put(JSON.stringify({ ...value, locale: "en" }), "preferences"); };
      tx.oncomplete = () => { db.close(); resolve(); }; tx.onerror = () => reject(tx.error); };
  }));
  await page.reload(); await waitForClientOnline(page);
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
}

test("owner deletes chosen and then all attachments of a conversation; messages show 附件已删除", async ({ page }, info) => {
  const f = await imageViewerFixture(page);
  try {
    const second = await idOf(f.hub, "第二张.png"), first = await idOf(f.hub, "第一张.png");
    expect(await blob(f.hub.attachments.directory, second)).toBe(true);
    await openWorkspacePage(page, "文件中心");
    const center = page.getByRole("dialog", { name: "文件中心", exact: true });
    await center.getByRole("tab", { name: "附件管理", exact: true }).click();
    await expect(center.getByRole("tab", { name: "附件管理", exact: true })).toHaveAttribute("aria-selected", "true");
    await expect(center.locator(".file-center-summary")).toContainText("4");
    await center.getByRole("button", { name: /图片手势/ }).click();
    const details = center.getByRole("complementary", { name: "对话附件", exact: true });
    await expect(details.locator(".attachment-list > li")).toHaveCount(4);
    await details.getByRole("combobox", { name: "附件排序", exact: true }).selectOption("time");
    await expect(details.locator(".attachment-list > li")).toHaveCount(4);
    await expect(details.getByRole("button", { name: "删除所选（0）", exact: true })).toBeDisabled();
    await details.getByRole("checkbox", { name: "选择附件 第二张.png", exact: true }).check();
    await details.getByRole("button", { name: "删除所选（1）", exact: true }).click();
    const confirm = details.getByRole("alertdialog", { name: "确认删除附件", exact: true });
    await expect(confirm).toContainText("删除 1 个附件，释放");
    await page.screenshot({ path: info.outputPath("attachment-confirm.png") });
    await confirm.getByRole("button", { name: "确认删除", exact: true }).click();
    await expect(center.locator(".file-center-notices")).toContainText("已删除 1 个附件");
    await expect(details.locator(".attachment-list > li")).toHaveCount(3);
    expect(await blob(f.hub.attachments.directory, second)).toBe(false);
    expect(await blob(f.hub.attachments.directory, first)).toBe(true);
    // Locate closes File Center on the message; the deleted image says so at once.
    await details.getByRole("button", { name: "定位到附件 第一张.png 的消息", exact: true }).click();
    await expect(center).toHaveCount(0);
    await expect(page.locator(".attachment-image .image-load-state.is-deleted")).toHaveText("附件已删除");
    await expect(page.getByRole("button", { name: "第一张", exact: true })).toBeVisible();
    // A fresh load learns it from the host (410 attachment_deleted), not memory.
    await page.reload(); await waitForClientOnline(page);
    await expect(page.locator(".attachment-image .image-load-state.is-deleted")).toHaveText("附件已删除");
    await expect(page.locator(".attachment-image .image-load-state.is-deleted").getByRole("button")).toHaveCount(0);
    await openWorkspacePage(page, "文件中心");
    await center.getByRole("tab", { name: "附件管理", exact: true }).click();
    await center.getByRole("button", { name: /图片手势/ }).click();
    await details.getByRole("button", { name: "删除全部附件", exact: true }).click();
    await expect(confirm).toContainText("删除 3 个附件");
    await confirm.getByRole("button", { name: "确认删除", exact: true }).click();
    await expect(center.locator(".file-center-notices")).toContainText("已删除 3 个附件");
    await expect(center.getByText("暂无占用空间的附件。", { exact: true })).toBeVisible();
    expect(await blob(f.hub.attachments.directory, first)).toBe(false);
  } finally { await page.close(); await f.close(); }
});

test("deleting the last page returns to the remaining attachments", async ({ page }) => {
  const f = await imageViewerFixture(page);
  try {
    const bytes = Buffer.from("x"), sha256 = createHash("sha256").update(bytes).digest("hex");
    // Four original images plus 97 tiny files: the second page has one item.
    for (let index = 0; index < 97; index++) {
      const id = await f.hub.attachments.importForBot("photo", { conversationId: f.chat.id, name: `page-${index}.txt`, mime: "text/plain", size: bytes.length, sha256 }, bytes);
      await f.hub.store.db.run("INSERT INTO message_attachments(message_id,attachment_id) VALUES(?,?)", [f.batch.id, id]);
    }
    await openWorkspacePage(page, "文件中心");
    const center = page.getByRole("dialog", { name: "文件中心", exact: true });
    await center.getByRole("tab", { name: "附件管理", exact: true }).click();
    await center.getByRole("button", { name: /图片手势/ }).click();
    const details = center.getByRole("complementary", { name: "对话附件", exact: true });
    await expect(details.locator(".attachment-list > li")).toHaveCount(100);
    await details.getByRole("button", { name: "下一页", exact: true }).click();
    await expect(details.locator(".attachment-list > li")).toHaveCount(1);
    await details.getByRole("checkbox").check();
    await details.getByRole("button", { name: "删除所选（1）", exact: true }).click();
    await details.getByRole("button", { name: "确认删除", exact: true }).click();
    await expect(center.locator(".file-center-notices")).toContainText("已删除 1 个附件");
    await expect(details.locator(".attachment-list > li")).toHaveCount(100);
    await expect(details.getByText("这个对话已没有可删除的附件。", { exact: true })).toHaveCount(0);
  } finally { await page.close(); await f.close(); }
});

for (const width of [1360, 820, 390]) test(`attachment management fits in English at ${width}px`, async ({ page }, info) => {
  await page.setViewportSize({ width, height: 860 });
  const f = await imageViewerFixture(page);
  try {
    await english(page);
    if (width > 760) { await page.getByRole("button", { name: /^(工作台：|Workspace:)/ }).filter({ visible: true }).click(); await page.getByRole("button", { name: "File center", exact: true }).filter({ visible: true }).click(); }
    else { await page.getByRole("navigation", { name: "Main navigation" }).getByRole("button", { name: "Me", exact: true }).click(); await page.getByRole("button", { name: "File center", exact: true }).filter({ visible: true }).click(); }
    const center = page.getByRole("dialog", { name: "File center", exact: true });
    await center.getByRole("tab", { name: "Attachments", exact: true }).click();
    await center.getByRole("button", { name: /图片手势/ }).click();
    const details = center.getByRole("complementary", { name: "Conversation attachments", exact: true });
    await details.locator(".attachment-list input[type=checkbox]").first().check();
    await details.getByRole("button", { name: "Delete selected (1)", exact: true }).click();
    await expect(details.getByRole("alertdialog")).toContainText("Delete 1 attachment(s) and free");
    const overflow = await center.evaluate(root => [...root.querySelectorAll("*")].filter(el => {
      const style = getComputedStyle(el); if (style.display === "none" || el.clientWidth === 0 || el.children.length) return false;
      return el.scrollWidth > el.clientWidth + 1 && !["auto", "scroll", "hidden"].includes(style.overflowX) && style.textOverflow !== "ellipsis";
    }).map(el => `${el.tagName}.${el.className}: ${el.textContent?.slice(0, 40)}`));
    expect(overflow).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath(`attachments-en-${width}.png`) });
  } finally { await page.close(); await f.close(); }
});
