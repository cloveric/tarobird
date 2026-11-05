import { test, expect, type Page } from "@playwright/test";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HubServer } from "../../src/hub/server.js";
import { preparePairing } from "./fixtures/pairing-invite.js";
import { selectConversation, showDisconnectedBots, waitForClientOnline } from "./fixtures/mobile.js";
import { openSettings, closeSettings } from "./fixtures/settings.js";

test.use({ serviceWorkers: "block" });
const panel = (page: Page) => page.getByRole("complementary", { name: "工作台", exact: true });
async function fixture(page: Page, native = false, english = false) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "workbench-usability-"));
  const hub = await HubServer.start({ stateDir: directory, clientDir: path.resolve("dist") });
  await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','工作台助手','fixture')");
  const conversation = await hub.store.createConversation("owner", ["alpha"], "工作台操作验收", "usability_chat");
  await page.goto(hub.url); await preparePairing(page, hub); await page.getByRole("button", { name: "配对此设备", exact: true }).click();
  await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
  await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" });
  await waitForClientOnline(page); await showDisconnectedBots(page); await selectConversation(page, conversation.title);
  if (native) await page.evaluate(() => {
    const tabs = new Map<string, any>(), listeners = new Set<(event: any) => void>();
    const fixture = { failClear: true, clearCalls: 0 };
    Object.assign(window, { workbenchNativeFixture: fixture, tarobotDesktop: {
      version: 1, engine: "electron", platform: "darwin", openSocket: async () => { throw Error("unexpected_socket"); },
      on: (event: string, receive: (payload: any) => void) => { if (event === "workbench-browser") listeners.add(receive); return () => listeners.delete(receive); },
      invoke: async (command: string, args: any) => {
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
  if (english) {
    await openSettings(page,"general"); await page.locator("#language").selectOption("en"); await closeSettings(page,true);
    // Phone settings return to Me; re-enter the conversation before Workbench.
    const navigation = page.getByRole("navigation", { name: "Main navigation", exact: true });
    if (await navigation.isVisible()) {
      await navigation.getByRole("button", { name: "Message", exact: true }).click();
      await page.locator(".mh-row").filter({ has: page.getByText(conversation.title, { exact: true }) }).click();
    }
  }
  await page.getByRole("button", { name: english ? "Workbench" : "工作台", exact: true }).click();
  await expect(page.getByRole("complementary",{name:english ? "Workbench" : "工作台",exact:true})).toBeVisible();
  return { close: async () => { await page.close(); await hub.close(); await rm(directory, { recursive: true, force: true }); } };
}
async function newNote(page: Page) {
  await panel(page).getByRole("button", { name: "新建内容", exact: true }).click();
  await panel(page).getByRole("button", { name: "新建笔记", exact: true }).click();
}

test("New content follows tabs and stays reachable when desktop and phone tabs overflow", async ({ page }, info) => {
  const f = await fixture(page);
  const wb = panel(page), add = wb.getByRole("button", { name: "新建内容", exact: true });
  try {
    await wb.locator('input[accept^=".md"]').setInputFiles({ name: "项目笔记.md", mimeType: "text/markdown", buffer: Buffer.from("# 项目笔记\n\n记录想法，整理资料，继续手头的工作。") });
    await expect(wb.getByRole("tab", { name: "项目笔记.md" })).toHaveAttribute("aria-selected", "true");
    const adjacent = async () => {
      const tab = (await wb.getByRole("tab").last().boundingBox())!, button = (await add.boundingBox())!;
      return { gap: button.x - tab.x - tab.width, centre: Math.abs(button.y + button.height / 2 - tab.y - tab.height / 2) };
    };
    await expect.poll(async () => (await adjacent()).gap).toBeGreaterThanOrEqual(0);
    await expect.poll(async () => (await adjacent()).gap).toBeLessThanOrEqual(8);
    expect((await adjacent()).centre).toBeLessThanOrEqual(1);
    await expect(wb.getByRole("textbox", { name: "笔记内容", exact: true })).toHaveValue(/记录想法/);
    const preview = (await wb.boundingBox())!;
    await page.screenshot({ path: info.outputPath("new-tab-adjacent-desktop.png"), clip: { ...preview, height: Math.min(preview.height, 230) } });
    await add.click(); const menu = wb.getByRole("menu"); await expect(menu).toBeVisible();
    const popup = (await menu.boundingBox())!, bounds = (await wb.boundingBox())!, button = (await add.boundingBox())!;
    expect(popup.x).toBeGreaterThanOrEqual(bounds.x);
    expect(popup.x + popup.width).toBeLessThanOrEqual(bounds.x + bounds.width);
    expect(button.x).toBeGreaterThanOrEqual(popup.x);
    expect(button.x + button.width).toBeLessThanOrEqual(popup.x + popup.width + 4);
    await page.keyboard.press("Escape"); await expect(add).toBeFocused();
    await wb.locator('input[accept^=".md"]').setInputFiles(Array.from({ length: 8 }, (_, i) => ({ name: `更多资料-${i + 1}.md`, mimeType: "text/markdown", buffer: Buffer.from(`资料 ${i + 1}`) })));
    await expect(wb.getByRole("tab")).toHaveCount(9);
    for (const width of [1360, 1000, 390, 320]) {
      await page.setViewportSize({ width, height: 844 });
      const strip = wb.locator(".workbench-tabs");
      await expect.poll(() => strip.evaluate(node => node.scrollWidth > node.clientWidth)).toBe(true);
      for (const end of [0, 100000]) {
        await strip.evaluate((node, x) => { node.scrollLeft = x; }, end);
        await expect(add).toBeInViewport();
        expect(await add.evaluate(node => { const r = node.getBoundingClientRect(); return node.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)); })).toBe(true);
        await add.click(); await expect(menu).toBeVisible();
        const rect = (await menu.boundingBox())!;
        expect(rect.x).toBeGreaterThanOrEqual(0); expect(rect.x + rect.width).toBeLessThanOrEqual(width);
        await page.keyboard.press("Escape"); await expect(add).toBeFocused();
      }
      if (width === 390) {
        await wb.getByRole("tab", { name: "更多资料-8.md", exact: true }).click();
        const preview = (await wb.boundingBox())!;
        await page.screenshot({ path: info.outputPath("new-tab-overflow-phone.png"), clip: { ...preview, height: Math.min(preview.height, 230) } });
      }
    }
    await add.click(); await menu.getByRole("button", { name: "新建笔记", exact: true }).click();
    const created = wb.getByRole("tab", { name: "笔记.md", exact: true });
    await expect(created).toHaveAttribute("aria-selected", "true"); await expect(created).toBeInViewport();
    await expect(wb.getByRole("tab")).toHaveCount(10);
  } finally { await f.close(); }
});

test("workbench menus dismiss with Escape and restore the opening control", async ({ page }, info) => {
  const f = await fixture(page);
  try {
    await page.screenshot({path:info.outputPath("01-empty-workbench.png")});
    const trigger = panel(page).getByRole("button", {name:"新建内容",exact:true});
    await trigger.click(); await expect(panel(page).getByRole("menu")).toBeVisible();
    await expect(panel(page).getByRole("menu").getByRole("button",{name:"设计",exact:true})).toBeFocused();
    await page.keyboard.press("ArrowDown"); await expect(panel(page).getByRole("button",{name:"导入设计",exact:true})).toBeFocused();
    await page.keyboard.press("ArrowDown"); await expect(panel(page).getByRole("button",{name:"新建白板",exact:true})).toBeFocused();
    await page.keyboard.press("ArrowDown"); await expect(panel(page).getByRole("button",{name:"新建笔记",exact:true})).toBeFocused();
    await page.keyboard.press("End"); await expect(panel(page).getByRole("button",{name:"导入 Markdown / 文本",exact:true})).toBeFocused();
    await page.screenshot({path:info.outputPath("02-content-menu.png")});
    await page.keyboard.press("Escape");
    await expect(panel(page).getByRole("menu")).toBeHidden();
    await expect(trigger).toBeFocused();
    await expect(panel(page)).toBeVisible();
    await trigger.click(); await page.keyboard.press("End"); await page.keyboard.press("Tab");
    await expect(panel(page).getByRole("menu")).toBeHidden();
  } finally { await f.close(); }
});

for (const expanded of [false, true]) test(`tab right-click menus stay with their target (expanded=${expanded})`, async ({ page }, info) => {
  const f = await fixture(page);
  try {
    await panel(page).locator('input[accept^=".md"]').setInputFiles([
      { name: "Alpha.md", mimeType: "text/markdown", buffer: Buffer.from("Keep Alpha") },
      { name: "Beta.md", mimeType: "text/markdown", buffer: Buffer.from("Keep Beta") },
    ]);
    const alpha = panel(page).getByRole("tab", { name: "Alpha.md", exact: true });
    const beta = panel(page).getByRole("tab", { name: "Beta.md", exact: true });
    await expect(beta).toHaveAttribute("aria-selected", "true");
    if (expanded) await panel(page).getByRole("button", { name: "展开到主区", exact: true }).click();
    await alpha.click({ button: "right", position: { x: 12, y: 12 } });
    const menu = page.getByRole("menu");
    await expect(menu).toBeVisible();
    await expect.poll(async () => {
      const target = await alpha.boundingBox(), popup = await menu.boundingBox();
      return target && popup ? Math.abs(popup.x - (target.x + 12)) : Infinity;
    }).toBeLessThanOrEqual(2);
    await expect(beta).toHaveAttribute("aria-selected", "true");
    await page.screenshot({ path: info.outputPath(`tab-context-${expanded ? "expanded" : "docked"}.png`) });
    // A menu over an inactive tab must rename that tab, not the selected one.
    await menu.getByRole("button", { name: "重命名", exact: true }).click();
    const dialog = panel(page).getByRole("dialog");
    await expect(dialog.getByRole("textbox")).toHaveValue("Alpha.md");
    await dialog.getByRole("textbox").fill("Alpha renamed.md");
    await dialog.getByRole("button", { name: "保存", exact: true }).click();
    const renamed = panel(page).getByRole("tab", { name: "Alpha renamed.md", exact: true });
    await expect(renamed).toBeVisible(); await expect(beta).toHaveAttribute("aria-selected", "true");
    const list = panel(page).getByRole("button", { name: "全部标签和已关闭内容", exact: true });
    await expect(panel(page).getByRole("button", { name: "当前标签选项", exact: true })).toHaveCount(0);
    await list.click();
    await panel(page).getByRole("button", { name: "标签选项：Beta.md", exact: true }).click();
    await expect(panel(page).getByRole("menu")).toBeVisible(); await expect(list).toHaveAttribute("aria-expanded", "true");
    await page.keyboard.press("Escape"); await expect(list).toBeFocused();
    await renamed.focus(); await page.keyboard.press("Shift+F10");
    await expect(menu).toBeVisible();
    const bounds = await renamed.boundingBox(), popup = await menu.boundingBox();
    expect(popup!.x).toBeGreaterThanOrEqual(bounds!.x - 1);
    expect(popup!.x).toBeLessThan(bounds!.x + bounds!.width);
    await page.keyboard.press("Escape"); await expect(menu).toBeHidden(); await expect(renamed).toBeFocused();
    // Changing viewport/scroll geometry dismisses the old anchor. A later
    // toolbar click must use its own disclosure, not a stale context position.
    await renamed.click({ button: "right" }); await expect(menu).toBeVisible();
    await page.setViewportSize({ width: 1100, height: 750 }); await expect(menu).toBeHidden();
    await list.click();
    await panel(page).getByRole("button", { name: "标签选项：Beta.md", exact: true }).click();
    await expect(panel(page).getByRole("menu")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(panel(page).getByRole("textbox", { name: "笔记内容", exact: true })).toHaveValue("Keep Beta");
  } finally { await f.close(); }
});

test("English recovery actions fit a narrow phone and remain usable", async ({page}, info) => {
  let fail=true;
  await page.route("**/vditor/4.0.1/dist/js/lute/lute.min.js", route => fail ? route.abort() : route.continue());
  const f=await fixture(page,false,true);
  const workbench=page.getByRole("complementary",{name:"Workbench",exact:true});
  try {
    await page.setViewportSize({width:320,height:740});
    await workbench.locator('input[accept^=".md"]').setInputFiles({name:"Note.md",mimeType:"text/markdown",buffer:Buffer.from("Content survives a failed editor load.")});
    await expect(workbench.getByRole("alert")).toContainText("The editor could not load");
    const geometry=await workbench.getByRole("alert").evaluate(node => ({width:node.clientWidth,scroll:node.scrollWidth,buttons:[...node.querySelectorAll("button")].map(button=>{const box=button.getBoundingClientRect();return {left:box.left,right:box.right};})}));
    expect(geometry.scroll).toBeLessThanOrEqual(geometry.width+1);
    expect(geometry.buttons.every(box=>box.left>=0&&box.right<=320)).toBe(true);
    await page.screenshot({path:info.outputPath("08-phone-english-recovery.png")});
    fail=false; await workbench.getByRole("button",{name:"Retry editor",exact:true}).click();
    await expect(workbench.getByRole("textbox",{name:"Note content",exact:true})).toHaveValue("Content survives a failed editor load.");
  } finally { await f.close(); }
});

test("website data clearing failures remain visible inside the active dialog and can be retried", async ({page}, info) => {
  const f=await fixture(page,true);
  try {
    await panel(page).getByRole("button",{name:"网页",exact:true}).click();
    await panel(page).getByRole("button",{name:"网页工具与下载",exact:true}).click();
    await page.getByRole("menu",{name:"网页工具",exact:true}).getByRole("button",{name:"清除浏览数据…",exact:true}).click();
    const dialog=panel(page).getByRole("dialog");
    await dialog.getByRole("button",{name:"清理所选数据",exact:true}).click();
    await expect.poll(() => page.evaluate(() => (window as any).workbenchNativeFixture.clearCalls)).toBe(1);
    await page.screenshot({path:info.outputPath("07-browser-clear-failed.png")});
    await expect(dialog.getByRole("alert")).toBeVisible();
    await expect(dialog.getByRole("button",{name:"清理所选数据",exact:true})).toBeEnabled();
    await page.evaluate(() => { (window as any).workbenchNativeFixture.failClear=false; });
    await dialog.getByRole("button",{name:"清理所选数据",exact:true}).click();
    await expect(dialog).toBeHidden();
    expect(await page.evaluate(() => (window as any).workbenchNativeFixture.clearCalls)).toBe(2);
  } finally { await f.close(); }
});

test("a failed note editor resource can be retried without losing the saved content", async ({page}, info) => {
  let fail = true;
  await page.route("**/vditor/4.0.1/dist/js/lute/lute.min.js", route => fail ? route.abort() : route.continue());
  const f = await fixture(page);
  try {
    await panel(page).locator('input[accept^=".md"]').setInputFiles({name:"恢复检查.md",mimeType:"text/markdown",buffer:Buffer.from("# 内容仍在\n\n编辑器加载失败也不能丢失这段文字。\n")});
    await expect(panel(page).getByRole("alert")).toContainText("编辑器未能加载");
    await page.screenshot({path:info.outputPath("03-editor-load-failed.png")});
    await page.evaluate(() => { const original=URL.createObjectURL; Object.assign(window,{restoreObjectURL:()=>{URL.createObjectURL=original;}}); URL.createObjectURL=()=>{throw Error("fixture_export_failed");}; });
    await panel(page).getByRole("button",{name:"导出 Markdown",exact:true}).click();
    await expect(panel(page).getByRole("alert")).toContainText("导出未完成");
    await expect(panel(page).getByRole("button",{name:"重新加载编辑器",exact:true})).toBeVisible();
    await page.evaluate(() => (window as any).restoreObjectURL());
    const download=page.waitForEvent("download");
    await panel(page).getByRole("button",{name:"导出 Markdown",exact:true}).click();
    expect(await readFile((await (await download).path())!,"utf8")).toBe("# 内容仍在\n\n编辑器加载失败也不能丢失这段文字。\n");
    await expect(panel(page).getByRole("alert")).toContainText("编辑器未能加载");
    fail = false;
    await panel(page).getByRole("button", {name:"重新加载编辑器",exact:true}).click({timeout:5000});
    await expect(panel(page).getByRole("textbox", {name:"笔记内容",exact:true})).toHaveValue("# 内容仍在\n\n编辑器加载失败也不能丢失这段文字。\n");
    await expect(panel(page).getByRole("alert")).toBeHidden();
    await page.screenshot({path:info.outputPath("04-editor-recovered.png")});
  } finally { await f.close(); }
});

test("phone tab options offer only usable single-page actions and closed notes can be deleted explicitly", async ({page}, info) => {
  const f = await fixture(page);
  try {
    await newNote(page);
    const note=panel(page).getByRole("textbox",{name:"笔记内容",exact:true});
    await expect(note).toBeVisible(); await note.fill("手机笔记内容");
    await expect(panel(page).locator(".workbench-markdown-editor")).toHaveAttribute("data-note-saved","true");
    await page.setViewportSize({width:390,height:844});
    await panel(page).getByRole("button",{name:"全部标签和已关闭内容",exact:true}).click();
    await panel(page).getByRole("button",{name:"标签选项：笔记.md",exact:true}).click();
    await page.screenshot({path:info.outputPath("05-phone-tab-options.png")});
    await expect(panel(page).getByRole("button",{name:"加入分屏",exact:true})).toHaveCount(0);
    await expect(panel(page).getByRole("button",{name:"移出分屏，保留标签",exact:true})).toHaveCount(0);
    await expect(panel(page).getByRole("button",{name:"向左移动",exact:true})).toHaveCount(0);
    await expect(panel(page).getByRole("button",{name:"向右移动",exact:true})).toHaveCount(0);
    await panel(page).getByRole("button",{name:"关闭标签",exact:true}).click();
    await panel(page).getByRole("button",{name:"全部标签和已关闭内容",exact:true}).click();
    await expect(panel(page).getByRole("menu")).toContainText("笔记.md");
    await panel(page).getByRole("button",{name:"删除这篇笔记：笔记.md",exact:true}).click();
    await expect(panel(page).getByRole("dialog")).toContainText("其他设计、笔记、白板和聊天消息保留");
    await expect(panel(page).getByRole("dialog")).toContainText("仅删除此对话中的「笔记.md」及其在当前设备保存的内容");
    await page.screenshot({path:info.outputPath("06-delete-closed-note-confirm.png")});
    await panel(page).getByRole("dialog").getByRole("button",{name:"取消",exact:true}).click();
    await panel(page).getByRole("button",{name:"全部标签和已关闭内容",exact:true}).click();
    await expect(panel(page).getByRole("menu")).toContainText("笔记.md");
    await panel(page).getByRole("button",{name:"删除这篇笔记：笔记.md",exact:true}).click();
    await panel(page).getByRole("dialog").getByRole("button",{name:"删除笔记",exact:true}).click();
    await panel(page).getByRole("button",{name:"全部标签和已关闭内容",exact:true}).click();
    await expect(panel(page).getByRole("menu")).not.toContainText("笔记.md");
  } finally { await f.close(); }
});

for (const next of ["新建白板", "新建笔记"]) test(`${next} keeps a failed whiteboard save editable until retry succeeds`, async ({ page }) => {
  const f = await fixture(page);
  try {
    await panel(page).getByRole("button", { name: "白板", exact: true }).click();
    await panel(page).getByRole("button", { name: "展开到主区", exact: true }).click();
    const canvas = panel(page).locator(".workbench-canvas").first();
    await expect(canvas).toHaveAttribute("data-board-saved", "true");
    const originalId = await canvas.getAttribute("data-board-id");
    await page.evaluate(id => {
      const put = IDBObjectStore.prototype.put;
      Object.assign(window, { restoreBoardSave: () => { IDBObjectStore.prototype.put = put; } });
      IDBObjectStore.prototype.put = function(value: any, key?: IDBValidKey) {
        if (this.name === "workbenchBoards" && value.id === id && value.revision > 0) throw new DOMException("fixture storage full", "QuotaExceededError");
        return key === undefined ? put.call(this, value) : put.call(this, value, key);
      };
    }, originalId);
    await canvas.getByTestId("toolbar-rectangle").locator("..").click();
    const bounds = (await canvas.locator("canvas.interactive").boundingBox())!;
    await page.mouse.move(bounds.x + bounds.width * .3, bounds.y + bounds.height * .4);
    await page.mouse.down(); await page.mouse.move(bounds.x + bounds.width * .6, bounds.y + bounds.height * .65, { steps: 4 }); await page.mouse.up();
    await expect(canvas.getByRole("button", { name: "重新保存", exact: true })).toBeVisible();
    await panel(page).getByRole("button", { name: "新建内容", exact: true }).click();
    await panel(page).getByRole("button", { name: next, exact: true }).click();
    await expect(panel(page).locator(".workbench-error")).toBeVisible();
    await expect(panel(page).getByRole("tab")).toHaveCount(1);
    await expect(canvas).toHaveAttribute("data-board-id", originalId!);
    await expect(canvas).toHaveAttribute("data-board-saved", "false");
    await page.evaluate(() => (window as any).restoreBoardSave());
    await panel(page).getByRole("button", { name: "新建内容", exact: true }).click();
    await panel(page).getByRole("button", { name: next, exact: true }).click();
    await expect(panel(page).getByRole("tab")).toHaveCount(2);
    const saved = await page.evaluate(async id => {
      for (const entry of await indexedDB.databases()) {
        if (!entry.name) continue;
        const db = await new Promise<IDBDatabase>((resolve, reject) => { const open = indexedDB.open(entry.name!); open.onsuccess = () => resolve(open.result); open.onerror = () => reject(open.error); });
        try {
          if (!db.objectStoreNames.contains("workbenchBoards")) continue;
          const rows = await new Promise<any[]>((resolve, reject) => { const read = db.transaction("workbenchBoards").objectStore("workbenchBoards").getAll(); read.onsuccess = () => resolve(read.result); read.onerror = () => reject(read.error); });
          const board = rows.find(row => row.id === id); if (board) return { revision: board.revision, elements: board.scene.elements.length };
        } finally { db.close(); }
      }
    }, originalId);
    expect(saved?.revision).toBeGreaterThan(0); expect(saved?.elements).toBe(1);
  } finally { await f.close(); }
});

for (const english of [false, true]) for (const native of [true, false]) test(`empty Workbench actions stay inside narrow panels with neutral labels (${english ? "en" : "zh"}, ${native ? "desktop" : "phone"})`, async ({ page }, info) => {
  // Native browser capability is desktop-only. A separate browser context tests
  // phone layout without claiming a desktop bridge can resize into a phone.
  if (!native) await page.setViewportSize({ width: 390, height: 844 });
  const f = await fixture(page, native, english);
  const wb = page.getByRole("complementary", { name: english ? "Workbench" : "工作台", exact: true });
  try {
    const empty = wb.locator(".workbench-empty");
    await expect(empty.getByRole("button")).toHaveCount(native ? 5 : 4);
    expect.soft(await empty.innerText()).not.toMatch(/baoyu/i);
    await wb.getByRole("button", { name: english ? "New content" : "新建内容", exact: true }).click();
    expect.soft(await wb.getByRole("menu").innerText()).not.toMatch(/baoyu/i);
    await page.keyboard.press("Escape");
    const contained = async () => empty.getByRole("button").evaluateAll(buttons => {
      const bounds = buttons[0].closest(".workbench")!.getBoundingClientRect();
      return buttons.map(button => {
        const rect = button.getBoundingClientRect();
        return { text: button.textContent, inside: rect.left >= bounds.left && rect.right <= bounds.right && rect.top >= bounds.top && rect.bottom <= bounds.bottom, oneLine: rect.height <= 40 };
      });
    });
    if (native) {
      const resize = wb.getByRole("separator", { name: english ? "Resize workbench" : "调整工作台宽度", exact: true });
      await resize.focus(); await page.keyboard.press("Home");
      await expect(resize).toHaveAttribute("aria-valuenow", "320");
      await page.screenshot({ path: info.outputPath("empty-narrow-desktop.png") });
      for (const button of await contained()) { expect.soft(button.inside, JSON.stringify(button)).toBe(true); expect.soft(button.oneLine, JSON.stringify(button)).toBe(true); }
      const divider = (await resize.boundingBox())!;
      await page.mouse.move(divider.x + divider.width / 2, divider.y + divider.height / 2);
      await page.mouse.down(); await page.mouse.move(divider.x - 160, divider.y + divider.height / 2, { steps: 8 }); await page.mouse.up();
      for (const button of await contained()) expect.soft(button.inside, JSON.stringify(button)).toBe(true);
    } else {
      for (const width of [390, 320]) {
        await page.setViewportSize({ width, height: 844 });
        await expect(wb).toBeVisible();
        for (const button of await contained()) { expect.soft(button.inside, `${width}: ${JSON.stringify(button)}`).toBe(true); expect.soft(button.oneLine, `${width}: ${JSON.stringify(button)}`).toBe(true); }
        await page.screenshot({ path: info.outputPath(`empty-phone-${width}.png`) });
      }
    }
    await expect(empty.getByRole("button", { name: english ? "Canvas" : "画布", exact: true })).toBeVisible();
    await expect(empty.getByRole("button", { name: "PPT", exact: true })).toBeVisible();
  } finally { await f.close(); }
});
