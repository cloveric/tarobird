import { preparePairing } from "./fixtures/pairing-invite.js";
import { showDisconnectedBots, waitForClientOnline } from "./fixtures/mobile.js";
import { test, expect, type Page } from "@playwright/test";
import { enterMobileChat, mobileHome, selectConversation } from "./fixtures/mobile.js";
import { openSettings, closeSettings } from "./fixtures/settings.js";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HubError } from "../../src/hub/store.js";
import { HubServer } from "../../src/hub/server.js";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jI1EAAAAASUVORK5CYII=", "base64");
test("desktop files drop onto the conversation body and only into the targeted ADHD pane", async ({ page }, info) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "attachment-drop-")), hub = await HubServer.start({ stateDir: root, clientDir: process.env.TAROBOT_E2E_CLIENT_DIR ?? path.resolve("dist") });
  try {
    await hub.profile.update({ name: "测试主机", revision: (await hub.profile.read()).revision });
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','项目助手','fixture')");
    const first = await hub.store.createConversation("owner", ["alpha"], "图文一起讨论", "drop-first");
    const second = await hub.store.createConversation("owner", ["alpha"], "其他对话", "drop-second");
    await page.goto(hub.url); await expect(page.getByRole("button", { name: "配对此设备", exact: true })).toBeVisible();
    expect(await page.evaluate(() => {
      const dt = new DataTransfer(); dt.items.add(new File(["unpaired"], "unpaired.txt"));
      const drop = new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt }); document.body.dispatchEvent(drop);
      return drop.defaultPrevented;
    })).toBe(true);
    await pair(page, hub); await selectConversation(page, first.title);
    const transfer = await page.evaluateHandle(() => { const transfer = new DataTransfer(); transfer.items.add(new File(["Dropped attachment bytes"], "drop.txt", { type: "text/plain" })); return transfer; });
    const main = page.locator(".host-workspace:not([hidden]) .conversation-main");
    // A single visible chat owns window-wide file drops, including the sidebar.
    // Navigation is still prevented, and the file only enters its local draft.
    await expect.poll(() => page.locator(".host-workspace:not([hidden]) .sidebar").evaluate(node => {
      const dt = new DataTransfer(); dt.items.add(new File(["outside"], "outside.txt"));
      node.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: dt }));
      return document.querySelector(".conversation-main.is-file-drop-target") !== null;
    })).toBe(true);
    await page.screenshot({ path: info.outputPath("desktop-file-drop.png") });
    expect(await page.locator(".host-workspace:not([hidden]) .sidebar").evaluate((node) => {
      const dt = new DataTransfer(); dt.items.add(new File(["outside"], "outside.txt"));
      const over = new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: dt }); node.dispatchEvent(over);
      const effect = dt.dropEffect;
      const drop = new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt }); node.dispatchEvent(drop);
      return { over: over.defaultPrevented, drop: drop.defaultPrevented, effect };
    })).toMatchObject({ over: true, drop: true });
    await expect(main.getByRole("region", { name: "待发送的附件", exact: true })).toContainText("outside.txt");
    await main.getByRole("button", { name: "移除 outside.txt", exact: true }).click();
    await expect(main.getByRole("region", { name: "待发送的附件", exact: true })).toHaveCount(0);
    await page.evaluate(() => {
      for (const attribute of ["hidden", "inert"]) {
        const wrapper = document.createElement("div"); wrapper.dataset.dropFixture = attribute; wrapper.setAttribute(attribute, "");
        const dialog = document.createElement("dialog"); dialog.open = true; wrapper.append(dialog); document.body.append(wrapper);
      }
    });
    await main.locator(".message-scroll").dispatchEvent("dragenter", { dataTransfer: transfer });
    await expect.poll(async () => {
      await main.locator(".message-scroll").dispatchEvent("dragover", { dataTransfer: transfer });
      return (await main.getAttribute("class"))?.includes("is-file-drop-target");
    }).toBe(true);
    await expect(main).toHaveClass(/is-file-drop-target/);
    await main.locator(".message-scroll").dispatchEvent("drop", { dataTransfer: transfer });
    await expect(main).not.toHaveClass(/is-file-drop-target/);
    await expect(main.getByRole("region", { name: "待发送的附件", exact: true })).toContainText("drop.txt");
    await page.evaluate(() => { document.querySelectorAll("[data-drop-fixture]").forEach(node => node.remove()); });
    await main.locator(".message-scroll").evaluate(node => {
      const dt = new DataTransfer(); dt.items.add(new File([], "folder"));
      // Synthetic DataTransfer files have no filesystem entry. Supply only the
      // browser's directory metadata; real native directory drag remains a
      // separate acceptance gate, not something this fixture can prove.
      const original = Object.getOwnPropertyDescriptor(DataTransferItem.prototype, "webkitGetAsEntry")!;
      Object.defineProperty(DataTransferItem.prototype, "webkitGetAsEntry", { ...original, value: () => ({ isDirectory: true }) });
      try { node.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt })); }
      finally { Object.defineProperty(DataTransferItem.prototype, "webkitGetAsEntry", original); }
    });
    await expect(main.getByRole("region", { name: "待发送的附件", exact: true })).not.toContainText("folder");
    await expect(page.getByRole("alert")).toContainText("暂不支持拖入文件夹");
    await main.locator(".message-scroll").evaluate(node => {
      const dt = new DataTransfer(); dt.items.add(new File([], "empty.txt"));
      node.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt }));
    });
    await expect(main.getByRole("region", { name: "待发送的附件", exact: true })).toContainText("empty.txt");
    // The existing upload policy rejects empty uploads; this drop regression
    // verifies they are not misidentified as directories, without changing it.
    await main.getByRole("button", { name: "移除 empty.txt", exact: true }).click();
    await main.getByRole("button", { name: "发送消息", exact: true }).click();
    await expect(main.getByRole("region", { name: "待发送的附件", exact: true })).toHaveCount(0);
    const messages = (await hub.store.snapshot("owner", first.id)).messages;
    expect(messages).toHaveLength(1); expect(messages[0]!.blocks.filter(block => block.type === "file")).toHaveLength(1);
    await page.getByRole("button", { name: "打开 ADHD 模式", exact: true }).click();
    for (const chat of [first, second]) await page.getByRole("checkbox", { name: `加入面板：测试主机 · ${chat.title}`, exact: true }).check();
    const left = page.locator(`.adhd-card[data-pane-conversation="${first.id}"]`), right = page.locator(`.adhd-card[data-pane-conversation="${second.id}"]`);
    await expect(right.locator(".composer textarea")).toBeEnabled();
    await right.locator(".message-scroll").dispatchEvent("dragenter", { dataTransfer: transfer });
    await expect.poll(async () => {
      await right.locator(".message-scroll").dispatchEvent("dragover", { dataTransfer: transfer });
      return (await right.locator(".conversation-main").getAttribute("class"))?.includes("is-file-drop-target");
    }).toBe(true);
    await page.screenshot({ path: info.outputPath("adhd-file-drop.png") });
    await right.locator(".message-scroll").dispatchEvent("drop", { dataTransfer: transfer });
    await expect(right.getByRole("region", { name: "待发送的附件", exact: true })).toContainText("drop.txt");
    await expect(left.getByRole("region", { name: "待发送的附件", exact: true })).toHaveCount(0);
    // Internal text/queue/pane drags must not create attachments.
    await left.locator(".message-scroll").dispatchEvent("drop", { dataTransfer: await page.evaluateHandle(() => { const dt = new DataTransfer(); dt.setData("text/plain", "ordinary drag"); return dt; }) });
    await expect(left.getByRole("region", { name: "待发送的附件", exact: true })).toHaveCount(0);
    await transfer.dispose();
  } finally { await page.close(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});
async function pair(page: Page, hub: HubServer) {
  await page.goto(hub.url); await preparePairing(page, hub); await page.getByRole("button", { name: "配对此设备", exact: true }).click();
  await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
  await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" }); await showDisconnectedBots(page); if ((page.viewportSize()?.width ?? 1360) <= 760) { await expect(mobileHome(page)).toBeVisible(); await enterMobileChat(page, "图文一起讨论"); } else await waitForClientOnline(page);
}

test("phone plus offers camera, photos and files, preserves cancellation and sends a combined caption", async ({ browser }, info) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true });
  const page = await context.newPage();
  const root = await mkdtemp(path.join(os.tmpdir(), "attachment-menu-")), hub = await HubServer.start({ stateDir: root, clientDir: process.env.TAROBOT_E2E_CLIENT_DIR ?? path.resolve("dist") });
  try {
    await page.setViewportSize({ width: 390, height: 844 });
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','项目助手','fixture')");
    const conversation = await hub.store.createConversation("owner", ["alpha"], "图文一起讨论", "caption");
    await pair(page, hub);
    const plus = page.getByRole("button", { name: "添加附件", exact: true });
    const sheet = page.getByRole("dialog", { name: "添加附件", exact: true });
    const draft = page.getByRole("textbox", { name: "消息", exact: true });
    const tray = page.getByRole("region", { name: "待发送的附件", exact: true });
    await draft.fill("相机、图片和文档，一起发。无需补发说明。");
    expect(await plus.evaluate((node) => {
      const p = node.getBoundingClientRect(), mic = node.nextElementSibling!.getBoundingClientRect(), c = node.closest(".composer")!.getBoundingClientRect();
      return p.width >= 44 && p.height >= 44 && Math.abs(p.right - mic.left) <= 1 && Math.abs(p.y - mic.y) <= 1 && p.left >= c.left && mic.right <= c.right;
    })).toBe(true);
    // Neither the WebView tap overlay nor a theme fill should create a halo,
    // including when the touch lands on the SVG inside the button.
    await expect(plus).toHaveCSS("-webkit-tap-highlight-color", "rgba(0, 0, 0, 0)");
    await expect(plus.locator("svg")).toHaveCSS("-webkit-tap-highlight-color", "rgba(0, 0, 0, 0)");
    await plus.tap(); await expect(sheet).toBeVisible();
    await expect(plus).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    await expect(plus).toHaveCSS("box-shadow", "none");
    await expect(sheet.getByRole("button", { name: "拍照", exact: true })).toBeFocused();
    await page.screenshot({ path: info.outputPath("attachment-menu-phone.png") });
    // Native Back consumes the sheet, never the underlying chat or its draft.
    expect(await page.evaluate(() => !window.dispatchEvent(new Event("tarocub-native-back", { cancelable: true })))).toBe(true);
    await expect(sheet).toHaveCount(0); await expect(plus).toBeFocused();
    await expect(plus).toHaveCSS("outline-style", "none");
    await expect(page.locator('.composer')).toHaveCSS("outline-style", "none");
    await expect(page.locator('.composer')).toHaveCSS("box-shadow", "none");
    await page.screenshot({ path: info.outputPath("attachment-plus-after-touch.png") });
    await plus.press("Enter"); await expect(sheet).toBeVisible();
    await page.keyboard.press("Escape"); await expect(plus).toBeFocused();
    await expect(plus).toHaveCSS("outline-style", "solid");
    await expect(plus).toHaveCSS("outline-width", "2px");
    await expect(page.locator('.composer')).toHaveCSS("outline-style", "none");
    const originalPalette = await page.locator('html').getAttribute('data-palette');
    for (const palette of ['mono', 'cli', 'pixel', 'tty', 'paper', 'agent']) {
      await page.locator('html').evaluate((node, value) => node.setAttribute('data-palette', value), palette);
      await plus.tap(); await expect(sheet).toBeVisible();
      await expect(plus).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
      await expect(plus).toHaveCSS("box-shadow", "none");
      await sheet.getByRole('button', { name: '关闭附件菜单', exact: true }).tap();
      await expect(plus).toBeFocused();
      await expect(plus).toHaveCSS("outline-style", "none");
      await expect(page.locator('.composer')).toHaveCSS("outline-style", "none");
    }
    await page.locator('html').evaluate((node, value) => value === null ? node.removeAttribute('data-palette') : node.setAttribute('data-palette', value), originalPalette);
    for (const [label, name, mimeType, accept, capture, multiple] of [
      ["拍照", "现场照片.png", "image/png", "image/*", "environment", false],
      ["附加图片", "设计参考.png", "image/png", "image/*", null, true],
      ["上传附件", "需求.txt", "text/plain", null, null, true],
    ] as const) {
      await plus.click();
      const picker = page.waitForEvent("filechooser"); await sheet.getByRole("button", { name: label, exact: true }).click(); const chooser = await picker;
      expect(chooser.isMultiple()).toBe(multiple);
      expect(await chooser.element().getAttribute("accept")).toBe(accept);
      expect(await chooser.element().getAttribute("capture")).toBe(capture);
      await expect(sheet).toHaveCount(0);
      await chooser.setFiles({ name, mimeType, buffer: mimeType === "image/png" ? png : Buffer.from("完整需求") });
      await expect(tray).toContainText(name);
    }
    // Simulate the system picker's cancel event; do not equate this with device permission QA.
    await plus.click(); const cancelled = page.waitForEvent("filechooser"); await sheet.getByRole("button", { name: "拍照", exact: true }).click();
    await (await cancelled).element().dispatchEvent("cancel");
    await expect(tray.getByRole("listitem")).toHaveCount(3); await expect(draft).toHaveValue("相机、图片和文档，一起发。无需补发说明。");
    // Picking the same file after removal is allowed and emits another change.
    await tray.getByRole("button", { name: "移除 现场照片.png", exact: true }).click();
    await plus.click(); const repeat = page.waitForEvent("filechooser"); await sheet.getByRole("button", { name: "拍照", exact: true }).click();
    await (await repeat).setFiles({ name: "现场照片.png", mimeType: "image/png", buffer: png });
    await expect(tray.getByRole("listitem")).toHaveCount(3);
    await page.getByRole("button", { name: "发送消息", exact: true }).click();
    await expect(tray).toHaveCount(0);
    const messages = (await hub.store.snapshot("owner", conversation.id)).messages;
    expect(messages).toHaveLength(1);
    expect(messages[0]!.blocks.map((b) => b.type)).toEqual(["text", "image", "file", "image"]);
    expect(messages[0]!.blocks[0]).toEqual({ type: "text", text: "相机、图片和文档，一起发。无需补发说明。" });

    await openSettings(page, "general"); await page.locator("#language").selectOption("en"); await closeSettings(page, true);
    await mobileHome(page).getByRole("navigation", { name: "Main navigation" }).getByRole("button", { name: "Message", exact: true }).click();
    await enterMobileChat(page, "图文一起讨论");
    await page.setViewportSize({ width: 320, height: 640 });
    await page.getByRole("button", { name: "Add attachments", exact: true }).click();
    const english = page.getByRole("dialog", { name: "Add attachments", exact: true });
    for (const label of ["Take photo", "Photo library", "Upload file"]) {
      const row = english.getByRole("button", { name: label, exact: true }); await expect(row).toBeInViewport();
      expect(await row.evaluate((node) => { const r = node.getBoundingClientRect(); return r.height >= 44 && r.left >= 0 && r.right <= innerWidth; })).toBe(true);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath("attachment-menu-english-320.png") });
    await english.getByRole("button", { name: "Close attachment menu", exact: true }).click();
    await page.setViewportSize({ width: 1360, height: 900 });
    const desktop = page.waitForEvent("filechooser"); await page.getByRole("button", { name: "Add files", exact: true }).click();
    expect((await desktop).isMultiple()).toBe(true); await expect(page.locator("dialog[open]")).toHaveCount(0);
  } finally { await context.close(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});

test("camera and photo selections survive rotation across the phone breakpoint", async ({ page }) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "attachment-rotation-")), hub = await HubServer.start({ stateDir: root, clientDir: process.env.TAROBOT_E2E_CLIENT_DIR ?? path.resolve("dist") });
  try {
    await page.setViewportSize({ width: 390, height: 844 });
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','项目助手','fixture')");
    await hub.store.createConversation("owner", ["alpha"], "图文一起讨论", "caption"); await pair(page, hub);
    await page.getByRole("textbox", { name: "消息", exact: true }).fill("横屏选完仍保留说明");
    for (const source of ["拍照", "附加图片"]) {
      await page.getByRole("button", { name: "添加附件", exact: true }).click();
      const pending = page.waitForEvent("filechooser"); await page.getByRole("dialog", { name: "添加附件", exact: true }).getByRole("button", { name: source, exact: true }).click();
      const chooser = await pending;
      await page.setViewportSize({ width: 844, height: 390 });
      await expect(page.locator(".composer-add")).toHaveCount(0);
      await chooser.setFiles({ name: `${source}.png`, mimeType: "image/png", buffer: png });
      await expect(page.getByRole("region", { name: "待发送的附件", exact: true })).toContainText(`${source}.png`);
      await expect(page.getByRole("textbox", { name: "消息", exact: true })).toHaveValue("横屏选完仍保留说明");
      await page.setViewportSize({ width: 390, height: 844 });
      await expect(page.getByRole("button", { name: "添加附件", exact: true })).toBeVisible();
    }
    await expect(page.getByRole("region", { name: "待发送的附件", exact: true }).getByRole("listitem")).toHaveCount(2);
  } finally { await page.close(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});

test("a late phone picker result cannot enter a different chat or a revisited origin", async ({ page }) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "attachment-origin-")), hub = await HubServer.start({ stateDir: root, clientDir: process.env.TAROBOT_E2E_CLIENT_DIR ?? path.resolve("dist") });
  try {
    await page.setViewportSize({ width: 390, height: 844 });
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','项目助手','fixture')");
    await hub.store.createConversation("owner", ["alpha"], "图文一起讨论", "caption");
    await hub.store.createConversation("owner", ["alpha"], "另外一件事", "other");
    await pair(page, hub);
    for (const revisit of [false, true]) {
      await selectConversation(page, "图文一起讨论");
      // Await restored text before fill() selects/replaces it; this case tests
      // a late file chooser, not an IDB read racing the browser's input helper.
      await expect(page.getByRole("textbox", { name: "消息", exact: true })).toHaveValue(revisit ? "原对话的草稿" : "");
      await page.getByRole("textbox", { name: "消息", exact: true }).fill("原对话的草稿");
      await page.getByRole("button", { name: "添加附件", exact: true }).click();
      const pending = page.waitForEvent("filechooser"); await page.getByRole("dialog", { name: "添加附件", exact: true }).getByRole("button", { name: "附加图片", exact: true }).click();
      const chooser = await pending;
      await selectConversation(page, "另外一件事");
      await expect(page.getByRole("textbox", { name: "消息", exact: true })).toHaveValue(revisit ? "新对话自己的草稿" : "");
      await page.getByRole("textbox", { name: "消息", exact: true }).fill("新对话自己的草稿");
      if (revisit) await selectConversation(page, "图文一起讨论");
      await chooser.setFiles({ name: "迟到的图片.png", mimeType: "image/png", buffer: png });
      await expect(page.getByRole("region", { name: "待发送的附件", exact: true })).toHaveCount(0);
      await expect(page.getByRole("textbox", { name: "消息", exact: true })).toHaveValue(revisit ? "原对话的草稿" : "新对话自己的草稿");
    }
  } finally { await page.close(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});

test("desktop and phone compose text, pictures and documents together and synchronize one message per send", async ({ browser }, info) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "attachment-caption-")), hub = await HubServer.start({ stateDir: root, clientDir: process.env.TAROBOT_E2E_CLIENT_DIR ?? path.resolve("dist") });
  const desktopContext = await browser.newContext({ viewport: { width: 1360, height: 900 } }), phoneContext = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const desktop = await desktopContext.newPage(), phone = await phoneContext.newPage();
  try {
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','项目助手','fixture')");
    const conversation = await hub.store.createConversation("owner", ["alpha"], "图文一起讨论", "caption");
    await pair(desktop, hub); await pair(phone, hub);
    for (const [sender, receiver, name] of [[desktop, phone, "电脑"], [phone, desktop, "手机"]] as const) {
      const text = `${name}发来的两张图和说明文件，请结合这些附件分析。`;
      if (name === "电脑") await sender.getByRole("textbox", { name: "消息", exact: true }).fill(text);
      await sender.locator('input[type="file"][multiple]').setInputFiles([
        { name: `${name}方案一.png`, mimeType: "image/png", buffer: png },
        { name: `${name}方案二.png`, mimeType: "image/png", buffer: png },
        { name: "临时文件.txt", mimeType: "text/plain", buffer: Buffer.from("remove me") },
      ]);
      const previews = sender.getByRole("region", { name: "待发送的附件", exact: true });
      await expect(previews.locator("img")).toHaveCount(2); await previews.getByRole("button", { name: "移除 临时文件.txt", exact: true }).click();
      await sender.locator('input[type="file"][multiple]').setInputFiles({ name: `${name}说明.txt`, mimeType: "text/plain", buffer: Buffer.from(`${name}附件中的完整内容`) });
      if (name === "手机") await sender.getByRole("textbox", { name: "消息", exact: true }).fill(text);
      await expect(sender.getByRole("textbox", { name: "消息", exact: true })).toHaveValue(text);
      await expect(previews).toContainText("3 个附件");
      expect((await hub.store.snapshot("owner", conversation.id)).messages).toHaveLength(name === "电脑" ? 0 : 1);
      await sender.screenshot({ path: info.outputPath(name === "电脑" ? "attachment-composer-desktop.png" : "attachment-composer-phone.png"), fullPage: true });
      expect(await sender.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await sender.getByRole("button", { name: "发送消息", exact: true }).click();
      await expect(receiver.locator(".message-blocks").getByText(text, { exact: true })).toBeVisible();
      const messages = (await hub.store.snapshot("owner", conversation.id)).messages; expect(messages).toHaveLength(name === "电脑" ? 1 : 2);
      const message = messages.at(-1)!; expect(message.blocks.map((block) => block.type)).toEqual(["text", "image", "image", "file"]);
      const received = receiver.locator(`[data-message-id="${message.id}"]`); await expect(received.locator("img")).toHaveCount(2);
      await expect(received.getByRole("region", { name: `${name}说明.txt`, exact: true })).toBeVisible();
      await received.locator(".attachment-image button").first().click();
      await expect(receiver.getByRole("dialog", { name: "图片预览" })).toBeVisible();
      expect(await receiver.evaluate(() => !window.dispatchEvent(new Event("tarocub-native-back", { cancelable: true })))).toBe(true);
      await expect(receiver.getByRole("dialog", { name: "图片预览" })).toHaveCount(0);
      await received.getByRole("region", { name: `${name}说明.txt`, exact: true }).getByRole("button", { name: /^预览(?: |$)/ }).click();
      await expect(receiver.getByRole("dialog", { name: "文件预览" })).toContainText(`${name}附件中的完整内容`);
      expect(await receiver.evaluate(() => !window.dispatchEvent(new Event("tarocub-native-back", { cancelable: true })))).toBe(true);
      await expect(receiver.getByRole("dialog", { name: "文件预览" })).toHaveCount(0);
      // Phones do not render the desktop drawer at all; Back must not open one.
      await expect(receiver.locator(".sidebar.shown")).toHaveCount(0);
      for (const block of message.blocks) if ("attachmentId" in block) {
        const file = await hub.attachments.download({ userId: "owner" }, block.attachmentId);
        expect(await readFile(file.path)).toEqual(block.type === "image" ? png : Buffer.from(`${name}附件中的完整内容`));
      }
      await expect(previews).toHaveCount(0); await expect(sender.getByRole("textbox", { name: "消息", exact: true })).toHaveValue("");
    }
    expect(await hub.store.pendingForBot("alpha")).toHaveLength(2);
  } finally { await desktopContext.close(); await phoneContext.close(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});

test("HTML-only clipboard image becomes one attachment and uploads its exact bytes", async ({ page }) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "attachment-html-paste-")), hub = await HubServer.start({ stateDir: root, clientDir: process.env.TAROBOT_E2E_CLIENT_DIR ?? path.resolve("dist") });
  try {
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','助手','fixture')");
    const conversation = await hub.store.createConversation("owner", ["alpha"], "图文一起讨论", "html-paste"); await pair(page, hub);
    const composer = page.getByRole("textbox", { name: "消息", exact: true }); await composer.focus();
    await composer.evaluate(node => {
      const data = new DataTransfer(); data.setData("text/html", '<img src="data:image/png;base64,bm90LWFuLWltYWdl">');
      node.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: data }));
    });
    await expect(page.getByRole("alert")).toContainText("未能粘贴图片");
    await composer.evaluate((node, encoded) => {
      const data = new DataTransfer(); data.setData("text/plain", "[图片]"); data.setData("text/html", `<img src="data:image/png;base64,${encoded}">`);
      node.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: data }));
    }, png.toString('base64'));
    await expect(composer).toHaveValue("");
    await expect(page.getByRole("alert")).toHaveCount(0);
    await expect(page.getByRole("region", { name: "待发送的附件", exact: true }).getByRole("listitem")).toHaveCount(1);
    await page.getByRole("button", { name: "发送消息", exact: true }).click();
    await expect(page.getByRole("region", { name: "待发送的附件", exact: true })).toHaveCount(0);
    const messages = (await hub.store.snapshot("owner", conversation.id)).messages;
    expect(messages).toHaveLength(1); expect(messages[0]!.blocks).toHaveLength(1);
    const block = messages[0]!.blocks[0]!; expect(block.type).toBe("image");
    if (block.type !== "image") throw Error("Expected image");
    expect(await readFile((await hub.attachments.download({ userId: "owner" }, block.attachmentId)).path)).toEqual(png);
  } finally { await page.close(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});

test("mixed clipboard image and text preserve the caption at the caret, and a failed upload keeps the complete draft", async ({ page }) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "attachment-paste-")), hub = await HubServer.start({ stateDir: root, clientDir: process.env.TAROBOT_E2E_CLIENT_DIR ?? path.resolve("dist") });
  try {
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','助手','fixture')");
    const conversation = await hub.store.createConversation("owner", ["alpha"], "粘贴与拖入", "paste"); await pair(page, hub);
    const composer = page.getByRole("textbox", { name: "消息", exact: true }); await composer.fill("说明：替换这段。请一起分析。");
    await composer.evaluate((node, bytes) => {
      const input = node as HTMLTextAreaElement; input.setSelectionRange(3, 8);
      const data = new DataTransfer(); data.setData("text/plain", "粘贴的图片说明"); data.items.add(new File([Uint8Array.from(bytes)], "粘贴图片.png", { type: "image/png" }));
      input.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: data }));
    }, [...png]);
    await expect(composer).toHaveValue("说明：粘贴的图片说明请一起分析。");
    await page.locator(".composer").evaluate((node) => { const data = new DataTransfer(); data.items.add(new File(["补充数据"], "拖入文件.txt", { type: "text/plain" })); node.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: data })); });
    await expect(page.getByRole("region", { name: "待发送的附件", exact: true })).toContainText("2 个附件");
    // Fail the second file after the picture has uploaded: neither text nor picture
    // may be published as a partial message, and retry must retain the caption.
    const upload = hub.attachments.putChunk.bind(hub.attachments); let rejectDocument = true;
    hub.attachments.putChunk = async (userId, id, index, bytes) => {
      const row = await hub.store.db.get<{ name: string }>("SELECT name FROM attachments WHERE id=?", [id]);
      if (rejectDocument && row?.name === "拖入文件.txt") { rejectDocument = false; throw new HubError("fixture_upload_failure", 422); }
      return upload(userId, id, index, bytes);
    };
    await page.getByRole("button", { name: "发送消息", exact: true }).click();
    await expect(page.getByRole("alert")).toBeVisible(); expect((await hub.store.snapshot("owner", conversation.id)).messages).toHaveLength(0);
    await expect(composer).toHaveValue("说明：粘贴的图片说明请一起分析。"); await expect(page.getByRole("region", { name: "待发送的附件", exact: true }).getByRole("listitem")).toHaveCount(2);
    await page.getByRole("button", { name: "发送消息", exact: true }).click();
    await expect(page.locator(".message-blocks").getByText("说明：粘贴的图片说明请一起分析。", { exact: true })).toBeVisible();
    const messages = (await hub.store.snapshot("owner", conversation.id)).messages; expect(messages).toHaveLength(1); expect(messages[0]!.blocks.map((b) => b.type)).toEqual(["text", "image", "file"]);
  } finally { await page.close(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});

for (const width of [390, 320]) test(`draft attachments show three tappable thumbnails, preview locally and scroll to later files (${width}px)`, async ({ page, browserName }, info) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "draft-preview-")), hub = await HubServer.start({ stateDir: root, clientDir: process.env.TAROBOT_E2E_CLIENT_DIR ?? path.resolve("dist") });
  try {
    await page.setViewportSize({ width, height: 844 }); await page.emulateMedia({ reducedMotion: 'reduce' });
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','项目助手','fixture')");
    const chat = await hub.store.createConversation("owner", ["alpha"], "图文一起讨论", "caption");
    await page.addInitScript(() => {
      const visual = Object.assign(new EventTarget(), { height: innerHeight, width: innerWidth, offsetTop: 0, offsetLeft: 0, scale: 1 });
      Object.defineProperty(window, 'visualViewport', { configurable: true, value: visual });
      (window as any).draftKeyboard = (height = 460) => { visual.height = height; visual.dispatchEvent(new Event('resize')); };
    });
    await pair(page, hub);
    const pictures = await page.evaluate(() => ['#e9ebff', '#e0f1e6', '#ffe6df'].map((color, i) => {
      const canvas = document.createElement('canvas'); canvas.width = 180; canvas.height = 240;
      const c = canvas.getContext('2d')!; c.fillStyle = color; c.fillRect(0, 0, 180, 240);
      c.fillStyle = '#303342'; c.font = '24px sans-serif'; c.fillText(`RECEIPT ${i + 1}`, 16, 48);
      for (let y = 80; y < 210; y += 30) c.fillRect(16, y, 148 - y / 3, 4);
      return canvas.toDataURL('image/png').split(',')[1]!;
    }));
    // A single picture and a one-line caption should leave room to read the
    // conversation above the keyboard, with the local image already decoded.
    const picker = page.locator('input[type="file"][multiple]');
    const caption = page.getByRole('textbox', { name: '消息', exact: true });
    await picker.setInputFiles({ name: '收据1.png', mimeType: 'image/png', buffer: Buffer.from(pictures[0]!, 'base64') });
    await caption.fill('这张图的首页有点小。');
    await page.evaluate(() => (window as any).draftKeyboard());
    await expect.poll(() => page.locator('.composer').evaluate(node => node.getBoundingClientRect().height)).toBeLessThanOrEqual(190);
    await expect.poll(() => page.locator('.attachment-draft img').evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)).toBe(true);
    await expect.poll(() => page.locator('.message-scroll').evaluate(node => node.clientHeight)).toBeGreaterThan(100);
    await page.screenshot({ path: info.outputPath(`single-image-keyboard-${width}.png`), clip: { x: 0, y: 0, width, height: 460 } });
    await page.getByRole('button', { name: '移除 收据1.png', exact: true }).click();
    await expect(caption).toHaveValue('这张图的首页有点小。');
    await caption.fill('');
    await page.evaluate(() => (window as any).draftKeyboard(844));
    await picker.setInputFiles(pictures.map((data, i) => ({ name: `收据${i + 1}.png`, mimeType: 'image/png', buffer: Buffer.from(data, 'base64') })));
    const tray = page.getByRole('region', { name: '待发送的附件', exact: true });
    await expect(tray).toContainText('3 个附件');
    const opens = tray.getByRole('button', { name: /^预览 / });
    await expect(opens).toHaveCount(3);
    const allVisible = () => opens.evaluateAll(nodes => nodes.every(node => {
      const r = node.getBoundingClientRect(), list = node.closest('ul')!.getBoundingClientRect();
      return r.width >= 44 && r.height >= 44 && r.left >= list.left - 1 && r.right <= list.right + 1 && r.top >= list.top && r.bottom <= list.bottom + 1;
    }));
    await expect.poll(allVisible).toBe(true);
    await expect(tray.locator('.attachment-limit')).toHaveCount(0);
    await page.screenshot({ path: info.outputPath(`draft-three-${width}.png`) });
    await page.getByRole('textbox', { name: '消息', exact: true }).focus();
    await page.evaluate(() => (window as any).draftKeyboard());
    await expect.poll(allVisible).toBe(true);
    await expect.poll(() => page.getByRole('button', { name: '发送消息', exact: true }).evaluate(node => node.getBoundingClientRect().bottom <= 460)).toBe(true);
    await page.screenshot({ path: info.outputPath(`draft-keyboard-${width}.png`), clip: { x: 0, y: 0, width, height: 460 } });
    // Playwright WebKit's offline emulation also rejects newly created blob:
    // URLs (reproduced with a standalone canvas, without the App). Block HTTP
    // in that engine; Chromium additionally exercises full offline emulation.
    if (browserName === 'webkit') await page.route(/^https?:/, route => route.abort());
    else await page.context().setOffline(true);
    for (let i = 0; i < 3; i++) {
      await opens.nth(i).click();
      const preview = page.getByRole('dialog', { name: '图片预览', exact: true });
      await expect(preview.getByRole('img', { name: `收据${i + 1}.png`, exact: true })).toBeVisible();
      expect(await preview.locator('img').evaluate((img: HTMLImageElement) => img.naturalWidth > 0)).toBe(true);
      expect(await page.evaluate(() => !window.dispatchEvent(new Event('tarocub-native-back', { cancelable: true })))).toBe(true);
      await expect(preview).toHaveCount(0); await expect(opens.nth(i)).toBeFocused();
    }
    if (browserName === 'webkit') await page.unroute(/^https?:/);
    else await page.context().setOffline(false);
    // Compact trays can fit a fourth item without scrolling. Add enough items
    // to exercise actual overflow at both widths instead of assuming that the
    // fourth file always creates a next-page button.
    const extraDocuments = ['补充1.txt', '补充2.txt'];
    await page.locator('input[type="file"][multiple]').setInputFiles([
      ...extraDocuments.map(name => ({ name, mimeType: 'text/plain', buffer: Buffer.from(name) })),
      { name: '说明.txt', mimeType: 'text/plain', buffer: Buffer.from('<script>window.BAD=true</script>原始说明') },
    ]);
    await tray.getByRole('button', { name: '后面的附件', exact: true }).click();
    await tray.getByRole('button', { name: '预览 说明.txt', exact: true }).click();
    const preview = page.getByRole('dialog', { name: '附件预览', exact: true });
    await expect(preview).toContainText('<script>window.BAD=true</script>原始说明');
    expect(await page.evaluate(() => (window as any).BAD)).toBeUndefined();
    await page.keyboard.press('Escape'); await expect(preview).toHaveCount(0);
    await tray.getByRole('button', { name: '移除 说明.txt', exact: true }).click();
    for (const name of extraDocuments) await tray.getByRole('button', { name: `移除 ${name}`, exact: true }).click();
    await expect(opens).toHaveCount(3); await expect.poll(allVisible).toBe(true);
    await expect(page.getByLabel('草稿状态', { exact: true })).toHaveText('草稿已保存');
    await page.reload(); await enterMobileChat(page, '图文一起讨论');
    await expect(opens).toHaveCount(3); await opens.nth(2).click();
    const restoredImage = page.getByRole('dialog', { name: '图片预览', exact: true });
    await expect(restoredImage.getByRole('img', { name: '收据3.png', exact: true })).toBeVisible();
    await restoredImage.getByRole('button', { name: '关闭', exact: true }).click();
    expect((await hub.store.snapshot('owner', chat.id)).messages).toHaveLength(0);
    await page.getByRole('textbox', { name: '消息', exact: true }).fill('按日期记账');
    await page.getByRole('button', { name: '发送消息', exact: true }).click();
    await expect(tray).toHaveCount(0);
    const messages = (await hub.store.snapshot('owner', chat.id)).messages;
    expect(messages).toHaveLength(1); expect(messages[0]!.blocks.map(b => b.type)).toEqual(['text', 'image', 'image', 'image']);
  } finally { await page.close(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});

for (const width of [1360, 390]) test(`draft documents use the real readers and unsupported files retain original bytes (${width}px)`, async ({ page }) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'draft-documents-')), hub = await HubServer.start({ stateDir: root, clientDir: path.resolve('dist') });
  try {
    await page.setViewportSize({ width, height: 844 });
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','项目助手','fixture')");
    const chat = await hub.store.createConversation('owner', ['alpha'], '图文一起讨论', 'caption');
    await pair(page, hub);
    const files = [
      { name: 'reading.docx', mimeType: 'application/octet-stream', buffer: await readFile('e2e/fixtures/documents/reading.docx') },
      { name: 'reading.pdf', mimeType: 'application/pdf', buffer: await readFile('e2e/fixtures/pdf/reading.pdf') },
      { name: 'archive.zip', mimeType: 'application/zip', buffer: Buffer.from('original-unsupported-file') },
    ];
    await page.locator('input[type="file"][multiple]').setInputFiles(files);
    const tray = page.getByRole('region', { name: '待发送的附件', exact: true }), preview = page.getByRole('dialog', { name: '附件预览', exact: true });
    await tray.getByRole('button', { name: '预览 reading.docx', exact: true }).click();
    await expect(preview.getByRole('heading', { name: '文档阅读预览', exact: true })).toBeVisible();
    await preview.getByRole('button', { name: '关闭', exact: true }).click();
    await tray.getByRole('button', { name: '预览 reading.pdf', exact: true }).click();
    await expect(preview.getByText('PAGE_1_CONTENT', { exact: true })).toBeVisible();
    await expect.poll(() => preview.locator('canvas').evaluateAll(nodes => nodes.some(c => (c as HTMLCanvasElement).width > 0))).toBe(true);
    await page.keyboard.press('Escape');
    await tray.getByRole('button', { name: '预览 archive.zip', exact: true }).click();
    await expect(preview).toContainText('此文件不支持内置预览');
    const download = page.waitForEvent('download'); await preview.getByRole('button', { name: '另存为', exact: true }).click();
    const saved = await download; expect(saved.suggestedFilename()).toBe('archive.zip');
    expect(await readFile((await saved.path())!)).toEqual(files[2]!.buffer);
    await preview.getByRole('button', { name: '关闭', exact: true }).click();
    await expect(tray.getByRole('listitem')).toHaveCount(3);
    expect((await hub.store.snapshot('owner', chat.id)).messages).toHaveLength(0);
  } finally { await page.close(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});


test("desktop repeated image paste works after preview restores focus to an attachment", async ({ page, browserName }) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "repeat-paste-")), hub = await HubServer.start({ stateDir: root, clientDir: path.resolve("dist") });
  try {
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','项目助手','fixture')");
    const chat = await hub.store.createConversation("owner", ["alpha"], "图文一起讨论", "repeat-paste");
    await pair(page, hub); await selectConversation(page, chat.title);
    const main = page.locator(".host-workspace:not([hidden]) .conversation-main");
    const input = main.getByRole("textbox", { name: "消息", exact: true });
    await input.fill("before after");
    await input.evaluate(node => (node as HTMLTextAreaElement).setSelectionRange(7, 7));
    if (browserName === "chromium") await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
    const paste = async (caption = "") => {
      if (browserName === "chromium" && !caption) {
        await page.evaluate(async () => { const canvas = document.createElement("canvas"); canvas.width = canvas.height = 8; canvas.getContext("2d")!.fillRect(0, 0, 8, 8); const blob = await new Promise<Blob>(resolve => canvas.toBlob(blob => resolve(blob!), "image/png")); await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]); });
        await page.keyboard.press("ControlOrMeta+V"); return;
      }
      await page.evaluate(({ data, caption }) => {
      const transfer = new DataTransfer(); transfer.items.add(new File([Uint8Array.from(atob(data), c => c.charCodeAt(0))], "image.png", { type: "image/png" }));
      if (caption) transfer.setData("text/plain", caption);
      document.activeElement!.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: transfer }));
      }, { data: png.toString("base64"), caption });
    };
    await paste();
    const tray = main.getByRole("region", { name: "待发送的附件", exact: true });
    await expect(tray.getByRole("listitem")).toHaveCount(1);
    await tray.getByRole("button", { name: "预览 image.png", exact: true }).click();
    await paste(); // A portalled preview is not an input target.
    await expect(tray.getByRole("listitem")).toHaveCount(1);
    await page.keyboard.press("Escape");
    await expect(input).toBeFocused();
    await tray.getByRole("button", { name: "预览 image.png", exact: true }).focus(); // Container fallback also works for keyboard navigation.
    await paste();
    await expect(tray.getByRole("listitem")).toHaveCount(2);
    await expect(input).toHaveValue("before after");
    await expect(input).toBeFocused();
    await paste("caption ");
    await expect(input).toHaveValue("before caption after");
    await expect(tray.getByRole("listitem")).toHaveCount(3);
    await tray.getByRole("button", { name: "移除 image.png", exact: true }).last().click();
    await expect(input).toBeFocused();
    await tray.locator(".draft-attachment-summary").click(); await expect(input).toBeFocused();
    await paste(); await expect(tray.getByRole("listitem")).toHaveCount(3);
    const chooser = page.waitForEvent("filechooser"); await main.getByRole("button", { name: "添加文件", exact: true }).click();
    await (await chooser).element().dispatchEvent("cancel"); await expect(input).toBeFocused();
    await main.getByRole("button", { name: "发送消息", exact: true }).click();
    await expect(tray).toHaveCount(0);
    const messages = (await hub.store.snapshot("owner", chat.id)).messages;
    expect(messages).toHaveLength(1);
    expect(messages[0]!.blocks.filter(block => block.type === "image")).toHaveLength(3);
  } finally { await page.close(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});
