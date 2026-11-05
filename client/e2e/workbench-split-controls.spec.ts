import { test, expect, type Page } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HubServer } from "../../src/hub/server.js";
import { preparePairing } from "./fixtures/pairing-invite.js";
import { selectConversation, showDisconnectedBots, waitForClientOnline } from "./fixtures/mobile.js";
import { openSettings, closeSettings } from "./fixtures/settings.js";

test.use({ serviceWorkers: "block" });
const panel = (page: Page) => page.getByRole("complementary", { name: "工作台", exact: true });
async function fixture(page: Page, native = false, english = false) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "workbench-split-controls-"));
  const hub = await HubServer.start({ stateDir: directory, clientDir: path.resolve("dist") });
  await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','工作台助手','fixture')");
  const conversation = await hub.store.createConversation("owner", ["alpha"], "工作台操作验收", "usability_chat");
  await page.goto(hub.url); await preparePairing(page, hub); await page.getByRole("button", { name: "配对此设备", exact: true }).click();
  await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
  await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" });
  await waitForClientOnline(page); await showDisconnectedBots(page); await selectConversation(page, conversation.title);
  if (native) await page.evaluate(() => {
    const tabs = new Map<string, any>(), listeners = new Set<(event: any) => void>();
    const fixture = { failClear: true, clearCalls: 0, layouts: [] as any[] };
    Object.assign(window, { workbenchNativeFixture: fixture, tarobotDesktop: {
      version: 1, engine: "electron", platform: "darwin", openSocket: async () => { throw Error("unexpected_socket"); },
      on: (event: string, receive: (payload: any) => void) => { if (event === "workbench-browser") listeners.add(receive); return () => listeners.delete(receive); },
      invoke: async (command: string, args: any) => {
        if (command === "workbench_browser_layout") { fixture.layouts.push(args); return; }
        if (command !== "workbench_browser") return;
        if (args.action === "capabilities") return {status:"ok",window:"native-window"};
        if (args.action === "list") return {status:"ok",tabs:[...tabs.values()]};
        if (args.action === "downloads") return {status:"ok",downloads:[]};
        if (args.action === "clear_data") { fixture.clearCalls++; return fixture.failClear ? {status:"failed",error:"browser_clear_failed"} : {status:"ok"}; }
        if (args.action === "open") { const tab={tab:args.tab,url:args.url,title:"资料网页",state:"live",navigation:1};tabs.set(args.tab,tab);queueMicrotask(() => listeners.forEach(receive => receive({...tab,kind:"state"})));return {status:"ok",...tab}; }
        return {status:"ok"};
      },
    }});
  });
  if (english) { await openSettings(page,"general"); await page.locator("#language").selectOption("en"); await closeSettings(page,true); }
  await page.getByRole("button", { name: english ? "Workbench" : "工作台", exact: true }).click();
  await expect(page.getByRole("complementary",{name:english ? "Workbench" : "工作台",exact:true})).toBeVisible();
  return { close: async () => { await page.close(); await hub.close(); await rm(directory, { recursive: true, force: true }); } };
}
async function notes(page: Page, names: string[]) {
  await panel(page).locator('input[accept^=".md"]').setInputFiles(names.map(name => ({ name: `${name}.md`, mimeType: "text/markdown", buffer: Buffer.from(`# ${name}\n\n保留 ${name} 的内容\n`) })));
  await expect(panel(page).getByRole("tab", { name: `${names.at(-1)}.md`, exact: true })).toHaveAttribute("aria-selected", "true");
}
async function applySplit(page: Page, names: string[], english = false) {
  const picker = page.getByRole("dialog", { name: english ? "Choose split tabs" : "选择分屏标签", exact: true });
  // Clear first so changing a full selection can choose a different four.
  for (const box of await picker.getByRole("checkbox").all()) if (await box.isChecked()) await box.uncheck();
  for (const name of names) await picker.getByRole("checkbox", { name, exact: true }).check();
  await picker.getByRole("button", { name: english ? "Apply split" : "应用分屏", exact: true }).click();
  await expect(picker).toBeHidden();
}
const visibleNames = (page: Page) => panel(page).locator(".workbench-pane:visible").evaluateAll(nodes => nodes.map(node => node.getAttribute("aria-label")));
async function tabOptions(page: Page, name: string) {
  await panel(page).getByRole("button", { name: "全部标签和已关闭内容", exact: true }).click();
  await panel(page).getByRole("button", { name: `标签选项：${name}`, exact: true }).click();
}

test("the visible split action tiles two notes, merges without closing, and keeps draft and saved contents", async ({ page }, info) => {
  const f = await fixture(page);
  try {
    const split = panel(page).getByRole("button", { name: "分屏", exact: true });
    await expect(split).toBeVisible(); await expect(split).toBeDisabled();
    await expect(split).toHaveAttribute("title", "至少打开两个标签后可分屏");
    await notes(page, ["A"]); await expect(split).toBeDisabled();
    await notes(page, ["B"]); await expect(split).toBeEnabled();
    await expect(panel(page).getByRole("button", { name: "当前标签选项", exact: true })).toHaveCount(0);
    const draft = page.locator(".conversation-main textarea").last(); await draft.fill("保留聊天草稿");
    await page.screenshot({ path: info.outputPath("split-button-desktop.png") });
    await split.focus(); await page.keyboard.press("Enter"); await applySplit(page, ["A.md", "B.md"]);
    await expect.poll(() => visibleNames(page)).toEqual(["A.md", "B.md"]);
    await expect(panel(page).getByRole("button", { name: "合并分屏", exact: true })).toBeFocused();
    await expect(panel(page).getByRole("button", { name: "合并分屏", exact: true })).toHaveAttribute("aria-pressed", "true");
    await expect(panel(page).getByRole("tab", { name: "B.md", exact: true })).toHaveAttribute("aria-selected", "true");
    await panel(page).getByRole("tabpanel", { name: "B.md", exact: true }).getByRole("textbox", { name: "笔记内容", exact: true }).fill("B 的新内容");
    await panel(page).getByRole("button", { name: "合并分屏", exact: true }).click();
    await expect.poll(() => visibleNames(page)).toEqual(["B.md"]); await expect(panel(page).getByRole("tab")).toHaveCount(2);
    await expect(panel(page).locator(".workbench-pane:visible")).toHaveCSS("border-top-width", "0px");
    await split.click(); await applySplit(page, ["A.md", "B.md"]); await expect.poll(() => visibleNames(page)).toEqual(["A.md", "B.md"]);
    await expect(panel(page).getByRole("tabpanel", { name: "B.md", exact: true }).getByRole("textbox", { name: "笔记内容", exact: true })).toHaveValue("B 的新内容");
    await expect(draft).toHaveValue("保留聊天草稿");
    await page.screenshot({ path: info.outputPath("split-notes-desktop.png") });
    await page.reload(); await waitForClientOnline(page); await selectConversation(page, "工作台操作验收");
    await page.getByRole("button", { name: "工作台", exact: true }).click();
    await expect.poll(() => visibleNames(page)).toEqual(["A.md", "B.md"]); await expect(draft).toHaveValue("保留聊天草稿");
  } finally { await f.close(); }
});

test("more than four tabs keeps the active tab, restores a maximized split, and never closes omitted tabs", async ({ page }, info) => {
  const f = await fixture(page);
  try {
    await notes(page, ["A", "B", "C", "D", "E"]);
    const split = panel(page).getByRole("button", { name: "分屏", exact: true });
    await expect(split).toHaveAttribute("title", /选择 2–4/);
    await split.click(); await applySplit(page, ["A.md", "B.md", "C.md", "E.md"]); await expect.poll(() => visibleNames(page)).toEqual(["A.md", "B.md", "C.md", "E.md"]);
    await expect(panel(page).getByRole("tab")).toHaveCount(5);
    await panel(page).getByRole("tab", { name: "D.md", exact: true }).click({ button: "right" });
    await expect(page.getByRole("menu", { name: "标签选项", exact: true }).getByRole("button", { name: "加入分屏", exact: true })).toBeDisabled();
    await expect(page.getByRole("menu", { name: "标签选项", exact: true }).getByText("四个区域已满。点击标签可替换当前区域。", { exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    await panel(page).getByRole("button", { name: "放大当前区域", exact: true }).first().click();
    await expect.poll(() => visibleNames(page)).toEqual(["A.md"]);
    await panel(page).locator(".workbench-tab-actions").getByRole("button", { name: "返回分屏", exact: true }).click();
    await expect.poll(() => visibleNames(page)).toEqual(["A.md", "B.md", "C.md", "E.md"]);
    await panel(page).getByRole("button", { name: "合并分屏", exact: true }).click();
    await expect.poll(() => visibleNames(page)).toEqual(["A.md"]);
    await panel(page).getByRole("tab", { name: "D.md", exact: true }).click(); await split.click(); await applySplit(page, ["A.md", "B.md", "C.md", "D.md"]);
    await expect.poll(() => visibleNames(page)).toEqual(["A.md", "B.md", "C.md", "D.md"]);
    await panel(page).getByRole("button", { name: "展开到主区", exact: true }).click();
    await page.screenshot({ path: info.outputPath("split-four-expanded.png") });
    await panel(page).getByRole("tab", { name: "A.md", exact: true }).click({ button: "right" });
    await expect(page.getByRole("menu").getByRole("button", { name: "加入分屏", exact: true })).toHaveCount(0);
    await page.getByRole("menu").getByRole("button", { name: "仅显示此标签", exact: true }).click();
    await expect.poll(() => visibleNames(page)).toEqual(["A.md"]);
  } finally { await f.close(); }
});

test("notes, boards and browser pages tile together and native layout follows visible pages", async ({ page }, info) => {
  const f = await fixture(page, true);
  try {
    await notes(page, ["研究笔记"]);
    await panel(page).getByRole("button", { name: "新建内容", exact: true }).click();
    await panel(page).getByRole("button", { name: "新建白板", exact: true }).click();
    await expect(panel(page).locator(".excalidraw")).toBeVisible();
    await panel(page).getByRole("button", { name: "新建内容", exact: true }).click();
    await panel(page).getByRole("button", { name: "新建网页", exact: true }).click();
    await expect(panel(page).getByRole("textbox", { name: "网址或搜索", exact: true })).toBeVisible();
    await panel(page).getByRole("button", { name: "分屏", exact: true }).click();
    await expect.poll(() => page.evaluate(() => (window as any).workbenchNativeFixture.layouts.at(-1)?.hidden)).toBe(true);
    await applySplit(page, ["研究笔记.md", "白板", "资料网页"]);
    await expect.poll(() => page.evaluate(() => (window as any).workbenchNativeFixture.layouts.at(-1)?.hidden)).toBe(false);
    await expect(panel(page).locator(".workbench-pane:visible")).toHaveCount(3);
    await expect.poll(() => page.evaluate(() => {
      const view = (window as any).workbenchNativeFixture.layouts.at(-1)?.views[0], rect = document.querySelector(".workbench-browser-viewport")!.getBoundingClientRect();
      return !!view && Math.abs(view.width - rect.width) < 1 && Math.abs(view.height - rect.height) < 1;
    })).toBe(true);
    await page.screenshot({ path: info.outputPath("split-note-board-browser.png") });
    await panel(page).getByRole("tab", { name: "白板", exact: true }).click();
    await panel(page).getByRole("button", { name: "合并分屏", exact: true }).click();
    await expect.poll(() => page.evaluate(() => (window as any).workbenchNativeFixture.layouts.at(-1)?.views.length)).toBe(0);
    await expect(panel(page).getByRole("tab")).toHaveCount(3);
  } finally { await f.close(); }
});

test("the tab list manages the chosen tab without a global ellipsis and remains usable on phones", async ({ page }, info) => {
  const f = await fixture(page);
  try {
    await notes(page, ["A", "B"]);
    const list = panel(page).getByRole("button", { name: "全部标签和已关闭内容", exact: true });
    await tabOptions(page, "A.md");
    await expect(panel(page).getByRole("button", { name: "移出分屏，保留标签", exact: true })).toHaveCount(0);
    await panel(page).getByRole("button", { name: "重命名", exact: true }).click();
    const dialog = panel(page).getByRole("dialog"); await expect(dialog.getByRole("textbox")).toHaveValue("A.md");
    await dialog.getByRole("textbox").fill("计划.md"); await dialog.getByRole("button", { name: "保存", exact: true }).click();
    await expect(panel(page).getByRole("tab", { name: "B.md", exact: true })).toHaveAttribute("aria-selected", "true");
    await tabOptions(page, "计划.md"); await page.keyboard.press("Escape"); await expect(list).toBeFocused();
    await tabOptions(page, "B.md"); await panel(page).getByRole("button", { name: "返回标签列表", exact: true }).click();
    await expect(panel(page).getByRole("button", { name: "标签选项：计划.md", exact: true })).toBeVisible();
    await expect(panel(page).getByRole("button", { name: "标签选项：B.md", exact: true })).toBeFocused();
    await page.keyboard.press("Escape");
    await panel(page).getByRole("button", { name: "分屏", exact: true }).click();
    await applySplit(page, ["计划.md", "B.md"]);
    await list.click();
    await expect(panel(page).getByRole("button", { name: "计划.md", exact: true })).toHaveAccessibleDescription("分屏中");
    await page.keyboard.press("Escape");
    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 844 });
      await expect(panel(page).locator(".workbench-pane:visible")).toHaveCount(1);
      await expect(panel(page).getByRole("button", { name: /^(分屏|合并分屏)$/ })).toHaveCount(0);
      await tabOptions(page, "计划.md");
      await expect(panel(page).getByRole("button", { name: "加入分屏", exact: true })).toHaveCount(0);
      await expect(panel(page).getByRole("button", { name: "仅显示此标签", exact: true })).toHaveCount(0);
      expect(await panel(page).evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
      await page.screenshot({ path: info.outputPath(`tab-options-phone-${width}.png`) });
      await page.keyboard.press("Escape"); await expect(list).toBeFocused();
    }
    await page.setViewportSize({ width: 1360, height: 900 }); await expect(panel(page).locator(".workbench-pane:visible")).toHaveCount(2);
  } finally { await f.close(); }
});

test("merge refuses to hide an unsaved note until its failed save is retried", async ({ page }) => {
  const f = await fixture(page);
  try {
    await notes(page, ["A", "B"]); await panel(page).getByRole("button", { name: "分屏", exact: true }).click(); await applySplit(page, ["A.md", "B.md"]);
    const b = panel(page).getByRole("tabpanel", { name: "B.md", exact: true });
    await page.evaluate(() => { const put = IDBObjectStore.prototype.put; (window as any).restoreSplitPut = () => { IDBObjectStore.prototype.put = put; }; IDBObjectStore.prototype.put = function(...args) { if (this.name === "workbenchMarkdown") throw new DOMException("Full", "QuotaExceededError"); return put.apply(this, args as any); }; });
    await b.getByRole("textbox", { name: "笔记内容", exact: true }).fill("保存失败也不能丢失");
    await expect(b.getByRole("alert")).toBeVisible();
    await panel(page).getByRole("tab", { name: "A.md", exact: true }).click();
    await panel(page).getByRole("button", { name: "合并分屏", exact: true }).click();
    await expect(panel(page).locator(".workbench-error")).toBeVisible();
    await expect.poll(() => visibleNames(page)).toEqual(["A.md", "B.md"]);
    await expect(b.getByRole("textbox", { name: "笔记内容", exact: true })).toHaveValue("保存失败也不能丢失");
    await page.evaluate(() => (window as any).restoreSplitPut());
    await b.getByRole("button", { name: "重新保存", exact: true }).click();
    await expect(b.locator(".workbench-markdown-editor")).toHaveAttribute("data-note-saved", "true");
    await panel(page).getByRole("tab", { name: "A.md", exact: true }).click();
    await panel(page).getByRole("button", { name: "合并分屏", exact: true }).click();
    await expect.poll(() => visibleNames(page)).toEqual(["A.md"]);
    await panel(page).getByRole("tab", { name: "B.md", exact: true }).click();
    await expect(b.getByRole("textbox", { name: "笔记内容", exact: true })).toHaveValue("保存失败也不能丢失");
  } finally { await f.close(); }
});

test("English layout actions fit a narrow dock and phone tab management stays reachable", async ({ page }, info) => {
  const f = await fixture(page, false, true);
  try {
    const wb = page.getByRole("complementary", { name: "Workbench", exact: true });
    await wb.locator('input[accept^=".md"]').setInputFiles(["Long research notes.md", "Another reference.md"].map(name => ({ name, mimeType: "text/markdown", buffer: Buffer.from("Keep content") })));
    await page.setViewportSize({ width: 1000, height: 800 });
    await wb.getByRole("button", { name: "Split tabs", exact: true }).click();
    const chooser = wb.getByRole("dialog", { name: "Choose split tabs", exact: true });
    const bounds = await chooser.boundingBox(); expect(bounds).not.toBeNull();
    expect(bounds!.x).toBeGreaterThanOrEqual(0); expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(1000);
    await expect(chooser.getByRole("checkbox")).toHaveCount(2);
    await applySplit(page, ["Long research notes.md", "Another reference.md"], true);
    await expect(wb.locator(".workbench-pane:visible")).toHaveCount(2);
    const fits = () => wb.locator(".workbench-tabrow").evaluate(node => { const bounds = node.getBoundingClientRect(); return [...node.querySelectorAll(".workbench-tab-actions>button")].every(button => { const b = button.getBoundingClientRect(); return b.left >= bounds.left && b.right <= bounds.right && b.top >= bounds.top && b.bottom <= bounds.bottom; }); });
    await expect.poll(fits).toBe(true);
    await page.screenshot({ path: info.outputPath("split-english-narrow.png") });
    await page.setViewportSize({ width: 320, height: 844 });
    await wb.getByRole("button", { name: "All tabs and closed content", exact: true }).click();
    await wb.getByRole("button", { name: "Tab options: Long research notes.md", exact: true }).click();
    await expect(wb.getByRole("button", { name: "Back to tabs", exact: true })).toBeVisible();
    await expect.poll(fits).toBe(true); expect(await wb.evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
    await page.screenshot({ path: info.outputPath("tab-options-english-phone.png") });
  } finally { await f.close(); }
});


test("split chooser selects any four, cancels drafts, replaces a full selection and preserves omitted tabs", async ({ page }, info) => {
  const f = await fixture(page);
  try {
    await notes(page, ["计划", "资料", "想法", "草稿", "回顾", "清单"]);
    const wb = panel(page), picker = wb.getByRole("dialog", { name: "选择分屏标签", exact: true });
    const split = wb.getByRole("button", { name: "分屏", exact: true });
    await split.click();
    await expect(picker.getByRole("status")).toHaveText("已选 1/4");
    await expect(picker.getByRole("button", { name: "应用分屏", exact: true })).toBeDisabled();
    await expect(picker.getByRole("checkbox", { name: "清单.md", exact: true })).toBeFocused();
    await page.keyboard.press("Space"); await expect(picker.getByRole("status")).toHaveText("已选 0/4");
    await page.keyboard.press("Space"); await expect(picker.getByRole("status")).toHaveText("已选 1/4");
    await page.keyboard.press("Tab"); await expect(picker.getByRole("button", { name: "取消", exact: true })).toBeFocused();
    await page.keyboard.press("Shift+Tab"); await expect(picker.getByRole("checkbox", { name: "清单.md", exact: true })).toBeFocused();
    for (const name of ["资料.md", "草稿.md", "回顾.md"]) await picker.getByRole("checkbox", { name, exact: true }).check();
    await expect(picker.getByRole("status")).toHaveText("已选 4/4");
    await expect(picker.getByRole("checkbox", { name: "计划.md", exact: true })).toBeDisabled();
    await expect.poll(() => visibleNames(page)).toEqual(["清单.md"]);
    await page.evaluate(() => document.documentElement.setAttribute("data-mono-accent", "warm-gray"));
    // Wait for the existing checkbox checkmark transition before the preview.
    await expect.poll(() => picker.getByRole("checkbox", { name: "回顾.md", exact: true }).evaluate(node => getComputedStyle(node, "::before").transform)).toBe("none");
    await page.screenshot({ path: info.outputPath("split-picker-four.png") });
    await page.keyboard.press("Escape"); await expect(picker).toBeHidden(); await expect(split).toBeFocused();
    await split.click(); await expect(picker.getByRole("status")).toHaveText("已选 1/4");
    await picker.getByRole("checkbox").first().focus(); await page.keyboard.press("Shift+Tab");
    await expect(picker).toBeHidden(); await expect(split).toBeFocused();
    await split.click(); await picker.getByRole("button", { name: "取消", exact: true }).focus(); await page.keyboard.press("Tab");
    await expect(picker).toBeHidden(); await expect(wb.getByRole("button", { name: "展开到主区", exact: true })).toBeFocused();
    await split.click();
    await applySplit(page, ["资料.md", "草稿.md", "回顾.md", "清单.md"]);
    await expect.poll(() => visibleNames(page)).toEqual(["资料.md", "草稿.md", "回顾.md", "清单.md"]);
    const adjust = wb.getByRole("button", { name: "调整分屏", exact: true });
    await adjust.click(); await expect(picker.getByRole("status")).toHaveText("已选 4/4");
    await picker.getByRole("checkbox", { name: "回顾.md", exact: true }).uncheck();
    await expect(picker.getByRole("checkbox", { name: "计划.md", exact: true })).toBeEnabled();
    await picker.getByRole("checkbox", { name: "计划.md", exact: true }).check();
    await picker.getByRole("button", { name: "应用分屏", exact: true }).click();
    await expect.poll(() => visibleNames(page)).toEqual(["计划.md", "资料.md", "草稿.md", "清单.md"]);
    await expect(adjust).toBeFocused(); await expect(wb.getByRole("tab")).toHaveCount(6);
    await adjust.click(); await picker.getByRole("checkbox", { name: "清单.md", exact: true }).uncheck();
    await expect.poll(() => picker.getByRole("checkbox", { name: "草稿.md", exact: true }).evaluate(node => getComputedStyle(node, "::before").transform)).toBe("none");
    await page.screenshot({ path: info.outputPath("split-picker-adjust.png") });
    await picker.getByRole("button", { name: "取消", exact: true }).click();
    await expect.poll(() => visibleNames(page)).toEqual(["计划.md", "资料.md", "草稿.md", "清单.md"]);
    await expect(adjust).toBeFocused();
    await page.reload(); await waitForClientOnline(page); await selectConversation(page, "工作台操作验收");
    await page.getByRole("button", { name: "工作台", exact: true }).click();
    await expect.poll(() => visibleNames(page)).toEqual(["计划.md", "资料.md", "草稿.md", "清单.md"]);
    await adjust.click(); await applySplit(page, ["资料.md", "回顾.md"]);
    await expect.poll(() => visibleNames(page)).toEqual(["资料.md", "回顾.md"]);
    await expect(wb.getByRole("tab")).toHaveCount(6);
    await adjust.click(); await page.setViewportSize({ width: 390, height: 844 });
    await expect(picker).toBeHidden(); await expect(adjust).toHaveCount(0);
    await page.setViewportSize({ width: 1360, height: 900 });
    await expect.poll(() => visibleNames(page)).toEqual(["资料.md", "回顾.md"]);
  } finally { await f.close(); }
});


test("failed chooser apply retains the draft and keyboard focus for a successful retry", async ({ page }) => {
  const f = await fixture(page);
  try {
    await notes(page, ["A", "B", "C"]);
    const wb = panel(page), picker = wb.getByRole("dialog", { name: "选择分屏标签", exact: true });
    await wb.getByRole("button", { name: "分屏", exact: true }).click(); await applySplit(page, ["A.md", "B.md"]);
    const adjust = wb.getByRole("button", { name: "调整分屏", exact: true });
    await adjust.click(); await picker.getByRole("checkbox", { name: "A.md", exact: true }).uncheck();
    await picker.getByRole("checkbox", { name: "C.md", exact: true }).check();
    await page.evaluate(() => {
      const put = IDBObjectStore.prototype.put;
      (window as any).restoreChooserPut = () => { IDBObjectStore.prototype.put = put; };
      IDBObjectStore.prototype.put = function(...args) { if (this.name === "workbenchLayouts") throw new DOMException("Full", "QuotaExceededError"); return put.apply(this, args as any); };
    });
    const apply = picker.getByRole("button", { name: "应用分屏", exact: true });
    await apply.focus(); await page.keyboard.press("Enter");
    await expect(wb.locator(".workbench-error")).toBeVisible(); await expect(picker).toBeVisible();
    await expect(apply).toBeEnabled(); await expect(apply).toBeFocused();
    await expect.poll(() => visibleNames(page)).toEqual(["A.md", "B.md"]);
    await expect(picker.getByRole("checkbox", { name: "A.md", exact: true })).not.toBeChecked();
    await expect(picker.getByRole("checkbox", { name: "B.md", exact: true })).toBeChecked();
    await expect(picker.getByRole("checkbox", { name: "C.md", exact: true })).toBeChecked();
    await page.evaluate(() => (window as any).restoreChooserPut());
    await page.keyboard.press("Enter"); await expect(picker).toBeHidden();
    await expect.poll(() => visibleNames(page)).toEqual(["B.md", "C.md"]); await expect(adjust).toBeFocused();
    await expect(wb.getByRole("tab")).toHaveCount(3);
  } finally { await f.close(); }
});
