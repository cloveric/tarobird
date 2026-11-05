import { preparePairing } from "./fixtures/pairing-invite.js";
import { test, expect, type Page } from "@playwright/test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HubServer } from "../../src/hub/server.js";
import { clickAppAction } from "./fixtures/desktop-actions.js";

test.use({ serviceWorkers: "block" });

async function pair(page: Page, hub: HubServer, name: string) {
  await hub.profile.update({ name, revision: (await hub.profile.read()).revision });
  await page.getByLabel("主机名称", { exact: true }).fill(name); await page.getByLabel("Hub 地址", { exact: true }).fill(hub.url);
  await preparePairing(page, hub); await page.getByRole("button", { name: "配对此设备", exact: true }).click();
  await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
  await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" });
}
// Electron trafficLightPosition 18,21 draws three 14px buttons from x 18 to 77, y 21 to 34.
const controls = [[19, 22], [25, 28], [48, 28], [71, 28], [77, 34]] as const;
const underControls = (page: Page) => page.evaluate(points => points.map(([x, y]) => document.elementFromPoint(x, y)?.closest("button,a,input,select,textarea,[role=button],[role=tab]")?.outerHTML.slice(0, 80) ?? null), controls);

test("host notices above the title bar exclude only their own rectangle from native dragging", async ({ page, browserName }) => {
  test.skip(browserName !== "chromium", "Electron's app-region property belongs to Chromium");
  await page.setContent(`<html data-desktop-engine="electron"><body style="margin:0">
    <header data-tauri-drag-region="deep" style="height:80px">Chat title</header>
    <div class="host-error" role="alert">Waiting for local tasks<button>Close</button></div>
  </body></html>`);
  for (const file of ["hosts.css", "desktop-window-chrome.css"]) {
    await page.addStyleTag({ content: await readFile(path.resolve("src", file), "utf8") });
  }
  const notice = page.getByRole("alert"), header = page.locator("body>header");
  const region = (node: Element) => getComputedStyle(node).getPropertyValue("app-region");
  const close = page.getByRole("button", { name: "Close", exact: true });
  const buttonBox = (await close.boundingBox())!, headerBox = (await header.boundingBox())!;
  expect(buttonBox.y + buttonBox.height / 2).toBeLessThan(headerBox.y + headerBox.height);
  // DOM stacking alone cannot override Electron's underlying native drag hit
  // region. The fixed notice needs a bounded no-drag rectangle of its own.
  expect(await notice.evaluate(region)).toBe("no-drag");
  expect(await header.evaluate(region)).toBe("drag");
  await page.evaluate(() => { const dialog = document.createElement("dialog"); dialog.className = "lightbox"; dialog.innerHTML = '<header data-tauri-drag-region="deep">Image</header>'; document.body.append(dialog); dialog.showModal(); });
  expect(await notice.evaluate(region)).toBe("none");
  expect(await page.locator("dialog>header").evaluate(region)).toBe("drag");
  await page.locator("dialog").evaluate((node: HTMLDialogElement) => node.close());
  expect(await notice.evaluate(region)).toBe("no-drag");
  await page.evaluate(() => { delete document.documentElement.dataset.desktopEngine; });
  expect(await notice.evaluate(region)).toBe("none");
  await page.evaluate(() => { document.documentElement.dataset.desktopEngine = "electron"; });
  await notice.evaluate(node => node.querySelector("button")!.addEventListener("click", () => node.remove()));
  await close.click(); await expect(notice).toHaveCount(0);
  expect(await header.evaluate(region)).toBe("drag");
  expect(await page.locator("body").evaluate(region)).toBe("none");
});

test("Electron scroll content cannot subtract the title bar's native drag region", async ({ page, browserName }) => {
  test.skip(browserName !== "chromium", "Electron's app-region property belongs to Chromium");
  await page.setContent(`<html data-desktop-engine="electron"><body style="margin:0">
    <header data-tauri-drag-region="deep" style="height:64px;display:flex;align-items:center">
      <span style="flex:1">Title</span><button id="action">Action</button>
      <div class="desktop-menu" data-tauri-drag-region="false"><span id="menu-heading">Menu</span><button>Item</button></div>
    </header>
    <div id="history" style="height:200px;overflow:auto"><div style="height:1000px;padding-top:200px">
      <button id="history-action" style="height:64px;width:100%;display:block">History action</button>
      <div role="group"><span id="history-status">Message status</span></div>
    </div></div>
    <textarea aria-label="Draft">Draft retained</textarea>
    <section class="pairing-page" data-tauri-drag-region=""><h1>Pairing</h1><label>Address<input></label></section>
    <section role="dialog" class="image-preview-lightbox"><header class="image-preview-toolbar"><div class="image-preview-actions" data-tauri-drag-region="deep"><span>Image title</span><button>Close image</button></div></header><p>Image content</p></section>
  </body></html>`);
  await page.addStyleTag({ content: await readFile(path.resolve("src/desktop-window-chrome.css"), "utf8") });
  const region = (selector: string) => page.locator(selector).evaluate(node => getComputedStyle(node).getPropertyValue("app-region"));
  await page.locator("#history").evaluate(node => { node.scrollTop = 264; });
  // The hidden history control's *unclipped* bounds overlap the title bar.
  // Electron 44+ includes explicit no-drag regions even there. An ordinary
  // content element must instead contribute no native region at all.
  expect(await page.locator("#history-action").evaluate(node => node.getBoundingClientRect().top)).toBe(0);
  expect(await page.evaluate(() => !!document.elementFromPoint(300, 24)?.closest("header"))).toBe(true);
  expect(await region("#history-action")).toBe("none");
  expect(await region("#history-status")).toBe("none");
  expect(await region("textarea")).toBe("none");
  expect(await region("body>header")).toBe("drag");
  expect(await region("#action")).toBe("no-drag");
  expect(await region("#menu-heading")).toBe("no-drag");
  expect(await region(".pairing-page")).toBe("drag");
  expect(await region(".pairing-page h1")).toBe("no-drag");
  expect(await region(".pairing-page input")).toBe("no-drag");
  expect(await region(".image-preview-actions")).toBe("drag");
  expect(await region(".image-preview-actions button")).toBe("no-drag");
  expect(await region(".image-preview-lightbox>p")).toBe("none");
  await page.getByLabel("Draft").fill("Editing still works");
  await expect(page.getByLabel("Draft")).toHaveValue("Editing still works");
  await page.evaluate(() => {
    for (const cls of ["preferences-dialog", "creation-dialog"]) {
      const dialog = document.createElement("dialog"); dialog.className = cls;
      dialog.innerHTML = "<header>Small settings dialog</header>"; document.body.append(dialog); dialog.showModal();
    }
  });
  expect(await region("body>header")).toBe("none");
  expect(await region("dialog.preferences-dialog>header")).toBe("none");
  await page.locator("dialog.creation-dialog").evaluate((node: HTMLDialogElement) => node.close());
  expect(await region("body>header")).toBe("none");
  await page.locator("dialog.preferences-dialog").evaluate((node: HTMLDialogElement) => node.close());
  expect(await region("body>header")).toBe("drag");
  // This checks renderer regions, not OS window movement; native hit testing
  // and CUA acceptance are documented separately.
});

test("any modal over the title bar suspends shell handles but keeps its own window handles", async ({ page, browserName }) => {
  test.skip(browserName !== "chromium", "Electron's app-region property belongs to Chromium");
  // A report's close button sits at y≈28–60, over the 56px conversation header.
  await page.setContent(`<html data-desktop-engine="electron"><body style="margin:0">
    <header class="conversation-header" data-tauri-drag-region="deep" style="height:56px"><span>Chat</span><button id="header-action">Action</button></header>
    <dialog class="report-panel"><header><strong>Report</strong><button id="report-close">Close</button></header></dialog>
    <dialog class="widget-panel widget-expanded"><header><button id="widget-close">Close</button></header></dialog>
    <dialog class="lightbox image-preview-lightbox"><header class="image-preview-toolbar"><div class="image-preview-actions" data-tauri-drag-region="deep"><span>Image</span><button id="image-close">Close</button></div></header></dialog>
    <dialog class="lightbox file-preview-lightbox"><section class="file-preview"><header data-tauri-drag-region="deep"><span>Document</span><button id="file-close">Close</button></header><p>Preview</p></section></dialog>
    <dialog class="creation-dialog"><header>Rename</header></dialog>
  </body></html>`);
  await page.addStyleTag({ content: await readFile(path.resolve("src/desktop-window-chrome.css"), "utf8") });
  const region = (selector: string) => page.locator(selector).evaluate(node => getComputedStyle(node).getPropertyValue("app-region"));
  const modal = (selector: string, open: boolean) => page.locator(selector).evaluate((node: HTMLDialogElement, open) => open ? node.showModal() : node.close(), open);
  expect(await region("body>header")).toBe("drag");
  for (const selector of ["dialog.report-panel", "dialog.widget-panel"]) {
    await modal(selector, true);
    expect(await region("body>header"), selector).toBe("none");
    await modal(selector, false);
  }
  await modal("dialog.image-preview-lightbox", true);
  expect(await region("body>header")).toBe("none");
  expect(await region(".image-preview-actions")).toBe("drag");
  expect(await region("#image-close")).toBe("no-drag");
  // A small dialog opened above the lightbox: the lower toolbar handle must not cover it.
  await modal("dialog.creation-dialog", true);
  expect(await region(".image-preview-actions")).toBe("none");
  expect(await region("body>header")).toBe("none");
  await modal("dialog.creation-dialog", false);
  expect(await region(".image-preview-actions")).toBe("drag");
  await modal("dialog.image-preview-lightbox", false);
  // A document preview keeps its own header as the window handle.
  await modal("dialog.file-preview-lightbox", true);
  expect(await region("body>header")).toBe("none");
  expect(await region(".file-preview>header")).toBe("drag");
  expect(await region("#file-close")).toBe("no-drag");
  expect(await region(".file-preview>p")).toBe("none");
  await modal("dialog.file-preview-lightbox", false);
  expect(await region("body>header")).toBe("drag");
  expect(await region("#header-action")).toBe("no-drag");
});

test("the macOS overlay title bar keeps the traffic lights clear in every desktop layout, and the web stays unchanged", async ({ page }) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "window-chrome-"));
  const a = await HubServer.start({ stateDir: path.join(root, "a"), clientDir: path.resolve("dist") });
  const b = await HubServer.start({ stateDir: path.join(root, "b"), origins: [a.url] });
  try {
    for (const [hub, id] of [[a, "alpha"], [b, "beta"]] as const) {
      await hub.store.db.run("INSERT INTO bots(id,name,secret_hash,online) VALUES(?,?,?,1)", [id, `${id} 助手`, "fixture"]);
      const chat = await hub.store.createConversation("owner", [id], `${id} 对话`, `${id}-chat`);
      await hub.store.publishBotMessage(id, { conversationId: chat.id, status: "complete", blocks: [{ type: "text", text: "已经整理好了。" }] });
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(a.url); await pair(page, a, "macmini"); await clickAppAction(page, "连接另一台主机"); await pair(page, b, "MacBook");
    const shell = page.locator(".host-workspace:not([hidden]) .app-shell");
    const brand = shell.locator(":scope>.sidebar>.brand");
    await expect(page.getByLabel("筛选运行主机").filter({ visible: true }).first()).toBeVisible();
    await shell.locator(".sidebar [data-conversation-id]").first().click();
    // A browser keeps the normal brand row.
    await expect.poll(() => brand.evaluate(node => getComputedStyle(node).paddingLeft)).toBe("6px");
    await page.evaluate(() => { document.documentElement.dataset.windowChrome = "mac-overlay"; });
    // Wide: the lights sit in the brand row; the host filter and search start below it.
    expect(await underControls(page)).toEqual([null, null, null, null, null]);
    expect(await brand.locator(":scope>*").first().evaluate(node => node.getBoundingClientRect().left)).toBeGreaterThanOrEqual(88);
    expect(await page.locator(".host-controls").filter({ visible: true }).first().evaluate(node => node.getBoundingClientRect().top)).toBeGreaterThanOrEqual(56);
    // A menu lives inside the draggable brand row. Its padding and section
    // headings must opt out too; native Tauri already excludes item buttons.
    await brand.getByRole("button", { name: "新建", exact: true }).click();
    const menu = brand.getByRole("group", { name: "新建", exact: true });
    await expect(menu).toHaveAttribute("data-tauri-drag-region", "false");
    await expect(menu.getByRole("button").first()).toBeFocused();
    await page.keyboard.press("Escape"); await expect(menu).toHaveCount(0);
    await expect(brand.getByRole("button", { name: "新建", exact: true })).toBeFocused();
    // At the sidebar's supported minimum, the wordmark must not paint over
    // the Agent Bus control after the native buttons consume their space.
    const separator = shell.getByRole("separator", { name: "调整侧栏宽度", exact: true });
    await separator.focus(); await page.keyboard.press("Home");
    await expect(separator).toHaveAttribute("aria-valuenow", "200");
    const wordmark = brand.locator(".wordmark-text");
    await expect(wordmark).toHaveCSS("overflow", "hidden");
    await expect(wordmark).toHaveCSS("text-overflow", "ellipsis");
    expect(await wordmark.evaluate(node => node.getBoundingClientRect().right)).toBeLessThanOrEqual(await brand.getByRole("button", { name: "打开 Agent Bus", exact: true }).evaluate(node => node.getBoundingClientRect().left));
    await separator.dblclick();
    // Mid-width with details open hides the sidebar; the header takes the corner.
    await page.setViewportSize({ width: 1000, height: 760 });
    await shell.getByRole("button", { name: "查看对话详情", exact: true }).click();
    await expect(shell.locator(":scope>.conversation-details")).toBeVisible();
    await expect(shell.locator(":scope>.sidebar")).toBeHidden();
    expect(await underControls(page)).toEqual([null, null, null, null, null]);
    // Narrow: the phone layout keeps a strip above its headers.
    await page.setViewportSize({ width: 700, height: 760 });
    await expect.poll(() => underControls(page)).toEqual([null, null, null, null, null]);
    expect(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--app-safe-top").trim())).toBe("40px");
    // Full screen hides the lights, so nothing is reserved.
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.evaluate(() => { document.documentElement.toggleAttribute("data-window-fullscreen", true); });
    await expect.poll(() => brand.evaluate(node => getComputedStyle(node).paddingLeft)).toBe("6px");
  } finally { await a.close(); await b.close(); await rm(root, { recursive: true, force: true }); }
});

test("only the visible Mac image title row receives pointer input; fullscreen and web preserve image gestures", async ({ page }) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "window-chrome-image-"));
  const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve("dist") });
  try {
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash,online) VALUES('photo','图片助手','fixture',1)");
    const chat = await hub.store.createConversation("owner", ["photo"], "图片窗口", "window-image");
    const bytes = Buffer.from(await page.evaluate(() => { const c = document.createElement("canvas"); c.width = 160; c.height = 160; return c.toDataURL("image/png").split(",")[1]!; }), "base64");
    const attachmentId = await hub.attachments.importForBot("photo", { conversationId: chat.id, name: "window.png", mime: "image/png", size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") }, bytes);
    await hub.store.publishBotMessage("photo", { conversationId: chat.id, blocks: [{ type: "image", attachmentId, title: "窗口预览" }] });
    await page.goto(hub.url); await pair(page, hub, "验收主机");
    await page.getByRole("button", { name: "窗口预览", exact: true }).click();
    const viewer = page.getByRole("dialog", { name: "图片预览", exact: true });
    const title = viewer.locator(".image-preview-title"), row = viewer.locator(".image-preview-actions");
    const hitsRow = () => title.evaluate(node => { const r = node.getBoundingClientRect(); return !!document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)?.closest(".image-preview-actions"); });
    await expect.poll(hitsRow).toBe(false);
    await page.evaluate(() => { document.documentElement.dataset.windowChrome = "mac-overlay"; });
    await expect.poll(hitsRow).toBe(true);
    await expect(row).toHaveCSS("pointer-events", "auto");
    await page.keyboard.press("h"); await expect(viewer).toHaveAttribute("data-controls", "hidden");
    await expect.poll(hitsRow).toBe(false);
    await page.keyboard.press("h"); await expect.poll(hitsRow).toBe(true);
    await page.evaluate(() => { document.documentElement.toggleAttribute("data-window-fullscreen", true); });
    await expect.poll(hitsRow).toBe(false);
    await page.evaluate(() => { document.documentElement.removeAttribute("data-window-fullscreen"); });
    await expect.poll(hitsRow).toBe(true);
    // Controls still receive clicks instead of inheriting a drag surface.
    await viewer.getByRole("button", { name: "关闭", exact: true }).click(); await expect(viewer).toHaveCount(0);
  } finally { await hub.close(); await rm(root, { recursive: true, force: true }); }
});
