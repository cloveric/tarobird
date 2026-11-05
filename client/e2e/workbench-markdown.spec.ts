import { workbenchContentTargets } from "./fixtures/workbench-targets.js";
import { test, expect, type Page } from "@playwright/test";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HubServer } from "../../src/hub/server.js";
import type { WorkbenchBroker } from "../../src/hub/workbench.js";
import type { WorkbenchRequest, WorkbenchTarget } from "../../src/client-protocol/workbench.js";
import { preparePairing } from "./fixtures/pairing-invite.js";
import { selectConversation, showDisconnectedBots, waitForClientOnline } from "./fixtures/mobile.js";

test.use({ serviceWorkers: "block" });
async function fixture(page: Page) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "workbench-note-"));
  const hub = await HubServer.start({ stateDir: directory, clientDir: path.resolve("dist") });
  await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','笔记助手','fixture')");
  const conversation = await hub.store.createConversation("owner", ["alpha"], "笔记验收", "note_chat");
  await page.addInitScript(() => { document.addEventListener("DOMContentLoaded", () => {
    const meta = document.createElement("meta"); meta.httpEquiv = "Content-Security-Policy";
    meta.content = "script-src 'self'; worker-src 'self'; object-src 'none'; base-uri 'none'"; document.head.appendChild(meta);
  }); });
  await page.goto(hub.url); await preparePairing(page, hub); await page.getByRole("button", { name: "配对此设备", exact: true }).click();
  await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner"); await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" });
  await waitForClientOnline(page); await showDisconnectedBots(page); await selectConversation(page, conversation.title);
  const broker = (hub as unknown as { workbench: WorkbenchBroker }).workbench, actor = { userId: "owner", conversationId: conversation.id, validate: async () => undefined };
  await page.getByRole("button", { name: "工作台", exact: true }).click(); await expect(panel(page)).toBeVisible();
  await expect.poll(async () => (await workbenchContentTargets(broker, actor)).length).toBe(1);
  return { hub, conversation, targets: () => workbenchContentTargets(broker, actor), command: (request: WorkbenchRequest) => broker.request(actor, request), close: async () => { await page.close({ runBeforeUnload: false }); await hub.close(); await rm(directory, { recursive: true, force: true }); } };
}
const panel = (page: Page) => page.getByRole("complementary", { name: "工作台", exact: true });
const input = (page: Page) => panel(page).getByRole("textbox", { name: "笔记内容", exact: true });
const saved = async (page: Page) => { await expect(panel(page).locator(".workbench-markdown-editor").first()).toHaveAttribute("data-note-saved", "true"); };
async function create(f: Awaited<ReturnType<typeof fixture>>, title: string, content: string) {
  const receipt = await f.command({ requestId: `create_${title.replace(/\W/g, "_")}`, operation: "markdown.create", payload: { title, content } });
  expect(receipt).toMatchObject({ status: "applied", saved: true });
  return { ...receipt.target, tabId: (receipt.result as { tabId: string }).tabId } as WorkbenchTarget;
}

test("Vditor local resources, exact import/export, formatting, safe preview and saved reload", async ({ page }, info) => {
  const external: string[] = []; page.on("request", request => { if (!/^(https?:\/\/(127\.0\.0\.1|localhost)|data:|blob:)/.test(request.url())) external.push(request.url()); });
  const f = await fixture(page);
  try {
    const traceLimit = await page.evaluate(() => (Error as any).stackTraceLimit);
    const original = "\ufeff# 笔记😀\r\n\r\nhello\u00a0world\r\n\r\n";
    await panel(page).getByRole("button", { name: "新建内容", exact: true }).click();
    await panel(page).locator('input[accept^=".md"]').setInputFiles([{ name: "import.md", mimeType: "text/markdown", buffer: Buffer.from(original) }, { name: "other.txt", mimeType: "text/plain", buffer: Buffer.from("Other") }]);
    await panel(page).getByRole("tab", { name: "import.md", exact: true }).click(); await expect(input(page)).toHaveValue(original.replace(/\r\n/g, "\n"));
    expect(await page.evaluate(() => (Error as any).stackTraceLimit)).toBe(traceLimit);
    const download = page.waitForEvent("download"); await panel(page).getByRole("button", { name: "导出 Markdown", exact: true }).click();
    const file = await download; expect(file.suggestedFilename()).toBe("import.md"); expect(await readFile((await file.path())!, "utf8")).toBe(original);
    await input(page).selectText();
    await input(page).evaluate(node => { const data = new DataTransfer(); data.items.add(new File(["image bytes"], "image.png", { type: "image/png" })); node.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: data })); });
    await expect(input(page)).toHaveValue(original.replace(/\r\n/g, "\n"));
    await input(page).press("Control+Alt+7"); await input(page).press("Meta+Alt+8"); await expect(input(page)).toBeVisible();
    expect(await input(page).evaluate(node => { const event = new KeyboardEvent("keydown", { key: "#", code: "Digit3", ctrlKey: true, altKey: true, bubbles: true, cancelable: true }); node.dispatchEvent(event); return event.defaultPrevented; })).toBe(false);
    await input(page).press("Tab"); await expect(input(page)).not.toBeFocused();
    await input(page).fill(""); await input(page).evaluate(node => { const data = new DataTransfer(); data.setData("text/plain", "plain **md**"); data.setData("text/html", "<b>different html</b>"); node.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: data })); });
    await expect(input(page)).toHaveValue("plain **md**"); await saved(page);
    await input(page).fill("format this"); await input(page).selectText();
    await panel(page).locator('.vditor-toolbar button[data-type="bold"]').click(); await expect(input(page)).toHaveValue("**format this**"); await saved(page);
    await input(page).fill('# 标题\n\n- [ ] 待办\n\n<script>window.markdownPwned=1</script>\n<img src="https://example.invalid/leak" onerror="window.markdownPwned=2">'); await saved(page);
    await panel(page).getByRole("button", { name: "预览", exact: true }).click(); await expect(panel(page).getByRole("heading", { name: "标题", exact: true })).toBeVisible();
    expect(await page.evaluate(() => (window as any).markdownPwned)).toBeUndefined(); expect(external).toEqual([]);
    await panel(page).getByRole("button", { name: "编辑", exact: true }).click(); await input(page).fill("# 本地笔记\n\n- 自动保存\n- Bot 可协助修改\n"); await saved(page);
    await page.screenshot({ path: info.outputPath("markdown-desktop.png") });
    await page.reload(); await waitForClientOnline(page); await selectConversation(page, f.conversation.title); await page.getByRole("button", { name: "工作台", exact: true }).click();
    await expect(input(page)).toHaveValue("# 本地笔记\n\n- 自动保存\n- Bot 可协助修改\n");
    await page.setViewportSize({ width: 390, height: 844 }); await expect(input(page)).toBeVisible();
    expect(await panel(page).evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
    await page.screenshot({ path: info.outputPath("markdown-phone.png") });
  } finally { await f.close(); }
});

test("real Host note operations fence manual edits and IME, preserve atomic patches and undo", async ({ page }) => {
  const f = await fixture(page);
  try {
    const target = await create(f, "Bot.md", "# Draft\n\nUnique😀\n"); await expect(input(page)).toHaveValue("# Draft\n\nUnique😀\n");
    let result = await f.command({ requestId: "read_initial", operation: "markdown.read", target }); expect(result.status).toBe("success"); const revision = result.revision!;
    await input(page).fill("# Human edit\n\nUnique😀\n");
    result = await f.command({ requestId: "stale_bot", operation: "markdown.replace", target, expectedRevision: revision, payload: { content: "Should never overwrite" } }); expect(result.status).toBe("conflict");
    await expect(input(page)).toHaveValue("# Human edit\n\nUnique😀\n");
    result = await f.command({ requestId: "read_manual", operation: "markdown.read", target }); const updated = result.revision!;
    expect(await f.command({ requestId: "patch_atomic", operation: "markdown.patch", target, expectedRevision: updated, payload: { edits: [{ oldText: "Unique", newText: "Changed" }, { oldText: "Missing", newText: "Bad" }] } })).toMatchObject({ status: "not_executed" });
    const patch = { requestId: "patch_ok", operation: "markdown.patch" as const, target, expectedRevision: updated, payload: { edits: [{ oldText: "Unique", newText: "Changed" }] } };
    expect(await f.command(patch)).toMatchObject({ status: "applied", saved: true, revision: updated + 1 }); expect(await f.command(patch)).toMatchObject({ status: "applied", revision: updated + 1 });
    await expect(input(page)).toHaveValue("# Human edit\n\nChanged😀\n");
    expect(await f.command({ requestId: "undo", operation: "markdown.undo", target, expectedRevision: updated + 1 })).toMatchObject({ status: "applied", revision: updated + 2 });
    await expect(input(page)).toHaveValue("# Human edit\n\nUnique😀\n");
    expect(await f.command({ requestId: "redo", operation: "markdown.redo", target, expectedRevision: updated + 2 })).toMatchObject({ status: "applied", revision: updated + 3 });
    await input(page).dispatchEvent("compositionstart");
    await input(page).evaluate(node => { (node as HTMLTextAreaElement).value = "输入中文中"; node.dispatchEvent(new InputEvent("input", { bubbles: true, isComposing: true })); });
    const ime = await f.command({ requestId: "ime_replace", operation: "markdown.replace", target, expectedRevision: updated + 3, payload: { content: "Never" } }); expect(ime).toMatchObject({ status: "not_executed", error: "markdown_editing" });
    await input(page).dispatchEvent("compositionend"); await saved(page);
    result = await f.command({ requestId: "read_ime", operation: "markdown.read", target }); expect(result.result).toMatchObject({ content: "输入中文中" });
    await panel(page).getByRole("button", { name: "撤销笔记修改", exact: true }).click(); await expect(input(page)).toHaveValue("# Human edit\n\nChanged😀\n");
  } finally { await f.close(); }
});

test("failed save survives hiding, a second window is read only, and reopening acquires the lock", async ({ page, context }) => {
  const f = await fixture(page);
  try {
    const target = await create(f, "Retained.md", "Saved"); await expect(input(page)).toHaveValue("Saved");
    await page.evaluate(() => { const original = IDBObjectStore.prototype.put; (window as any).restoreNotePut = () => { IDBObjectStore.prototype.put = original; }; IDBObjectStore.prototype.put = function(...args) { if (this.name === "workbenchMarkdown") throw new DOMException("Full", "QuotaExceededError"); return original.apply(this, args as any); }; });
    await input(page).fill("Unsaved but retained"); await expect(panel(page).getByRole("alert")).toBeVisible();
    await input(page).fill("First extra typing"); await input(page).fill("Retained after more typing");
    await panel(page).getByRole("button", { name: "返回聊天", exact: true }).click(); await page.getByRole("button", { name: "工作台", exact: true }).click();
    await expect(input(page)).toHaveValue("Retained after more typing");
    await page.evaluate(() => (window as any).restoreNotePut()); await panel(page).getByRole("button", { name: "重新保存", exact: true }).click(); await saved(page);
    const second = await context.newPage(); await second.goto(f.hub.url); await waitForClientOnline(second); await showDisconnectedBots(second); await selectConversation(second, f.conversation.title); await second.getByRole("button", { name: "工作台", exact: true }).click();
    await expect(input(second)).toHaveAttribute("readonly", ""); await expect(input(second)).toHaveValue("Retained after more typing");
    await input(second).focus(); await expect(input(second)).toBeFocused();
    await input(second).evaluate(node => { const data = new DataTransfer(); data.setData("text/plain", "Should not paste"); node.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: data })); });
    await expect(input(second)).toHaveValue("Retained after more typing");
    await panel(second).getByRole("button", { name: "预览", exact: true }).click(); await expect(panel(second).getByRole("region", { name: "Markdown 预览" })).toBeVisible();
    await panel(second).getByRole("button", { name: "编辑", exact: true }).click();
    await panel(page).getByRole("button", { name: "返回聊天", exact: true }).click();
    await panel(second).getByRole("button", { name: "返回聊天", exact: true }).click(); await second.getByRole("button", { name: "工作台", exact: true }).click();
    await expect(input(second)).not.toHaveAttribute("readonly", ""); await input(second).fill("Second owns now"); await saved(second); await second.close();
    expect(target.tabId).toBeTruthy();
  } finally { await f.close(); }
});

test("split notes keep edits and Bot targets independent after closing a sibling editor", async ({ page }) => {
  const f = await fixture(page);
  try {
    const first = await create(f, "First.md", "First"), second = await create(f, "Second.md", "Second");
    await panel(page).getByRole("tab", { name: "First.md", exact: true }).click({ button: "right" });
    await page.getByRole("menu", { name: "标签选项", exact: true }).getByRole("button", { name: "加入分屏", exact: true }).click();
    const a = panel(page).getByRole("tabpanel", { name: "First.md", exact: true }), b = panel(page).getByRole("tabpanel", { name: "Second.md", exact: true });
    await expect(a.getByRole("textbox", { name: "笔记内容" })).toHaveValue("First"); await expect(b.getByRole("textbox", { name: "笔记内容" })).toHaveValue("Second");
    await a.getByRole("textbox", { name: "笔记内容" }).fill("Human first");
    expect(await f.command({ requestId: "split_second", operation: "markdown.patch", target: second, expectedRevision: 0, payload: { edits: [{ oldText: "Second", newText: "Bot second" }] } })).toMatchObject({ status: "applied", saved: true });
    await expect(a.getByRole("textbox", { name: "笔记内容" })).toHaveValue("Human first"); await expect(b.getByRole("textbox", { name: "笔记内容" })).toHaveValue("Bot second");
    await b.getByRole("button", { name: "移出分屏，保留标签", exact: true }).click();
    await a.getByRole("textbox", { name: "笔记内容" }).fill("First still edits");
    await expect(a.locator(".workbench-markdown-editor")).toHaveAttribute("data-note-saved", "true");
    expect(await f.command({ requestId: "split_read", operation: "markdown.read", target: first })).toMatchObject({ status: "success", result: { content: "First still edits" } });
  } finally { await f.close(); }
});
