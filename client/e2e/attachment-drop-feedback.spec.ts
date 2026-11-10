import { preparePairing } from "./fixtures/pairing-invite.js";
import { showDisconnectedBots, waitForClientOnline, selectConversation } from "./fixtures/mobile.js";
import { openSettings, closeSettings, openDevicePairing, closeDevicePairing } from "./fixtures/settings.js";
import { test, expect, type Locator, type Page } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import QRCode from "qrcode";
import { HubServer } from "../../src/hub/server.js";
import { hashSecret } from "../../src/hub/auth.js";
import { attachGateway } from "../../src/gateway/service.js";
import { createCoreServiceRuntime } from "../../src/core/runtime.js";
import { widgetBlock } from "../../src/client-protocol/widget.js";
import { pairingLink } from "../src/pairing-link.js";

// Chromium's CDP drag pipeline delivers real disk-backed Files and directory
// entries, and withholds `drop` while the page leaves dropEffect "none". This is
// browser evidence only: WKWebView, Finder, file promises and TCC remain with the
// native CUA audit and are not inferred from these results.
test.skip(({ browserName }) => browserName !== "chromium", "CDP drag pipeline is Chromium-only");
test.use({ serviceWorkers: "block" });

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jI1EAAAAASUVORK5CYII=", "base64");
type DragData = { files?: string[]; items?: { mimeType: string; data: string }[] };
type Point = { x: number; y: number };

async function osDrag(page: Page) {
  const cdp = await page.context().newCDPSession(page);
  const send = (type: string, { x, y }: Point, data: DragData) => cdp.send("Input.dispatchDragEvent", { type, x, y, data: { items: data.items ?? [], files: data.files, dragOperationsMask: 1 } });
  const at = async (target: Locator | Point): Promise<Point> => {
    if (!("boundingBox" in target)) return target;
    const box = (await target.boundingBox())!; return { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + Math.min(box.height / 2, 24)) };
  };
  // Browsers repeat dragover while a held drag sits still (HTML: every 350ms ± 200ms).
  // Model that, so a stationary gesture is not mistaken for a stalled one.
  let timer: ReturnType<typeof setInterval> | undefined, last = Promise.resolve();
  const hold = (p: Point, data: DragData) => { clearInterval(timer); timer = setInterval(() => { last = send("dragOver", p, data).then(() => undefined, () => undefined); }, 250); };
  const stop = async () => { clearInterval(timer); timer = undefined; await last; };
  page.once("close", () => clearInterval(timer));
  return {
    hover: async (target: Locator | Point, data: DragData) => { await stop(); const p = await at(target); await send("dragEnter", p, data); await send("dragOver", p, data); hold(p, data); return p; },
    move: async (target: Locator | Point, data: DragData) => { await stop(); const p = await at(target); await send("dragOver", p, data); hold(p, data); },
    drop: async (target: Locator | Point, data: DragData) => { await stop(); const p = await at(target); await send("dragOver", p, data); await send("drop", p, data); },
    leaveWindow: async (data: DragData) => { await stop(); await send("dragOver", { x: -20, y: -20 }, data); },
    // Chromium dispatches no DOM event for this: an OS cancel that leaves feedback behind.
    cancel: async (data: DragData) => { await stop(); await send("dragCancel", { x: 0, y: 0 }, data); },
    // No dragover at all, as when a removed node or silent OS cancel ends the heartbeat.
    stall: stop,
  };
}

async function setup() {
  const root = await mkdtemp(path.join(os.tmpdir(), "attachment-drop-feedback-")), finder = path.join(root, "finder");
  const hub = await HubServer.start({ stateDir: path.join(root, "hub"), clientDir: process.env.TAROBOT_E2E_CLIENT_DIR ?? path.resolve("dist") });
  const notes = Buffer.from("拖入附件的原始字节 · drop bytes\n");
  await mkdir(path.join(finder, "资料夹"), { recursive: true }); await writeFile(path.join(finder, "资料夹", "inner.txt"), "inside");
  await writeFile(path.join(finder, "notes.txt"), notes); await writeFile(path.join(finder, "pixel.png"), png); await writeFile(path.join(finder, "empty.bin"), "");
  await writeFile(path.join(finder, "说明.md"), "third file bytes");
  await hub.profile.update({ name: "测试主机", revision: (await hub.profile.read()).revision });
  await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','项目助手','fixture')");
  const first = await hub.store.createConversation("owner", ["alpha"], "图文一起讨论", "drop-first");
  const second = await hub.store.createConversation("owner", ["alpha"], "其他对话", "drop-second");
  return { root, hub, first, second, notes, file: (name: string) => path.join(finder, name), close: async () => { await hub.close(); await rm(root, { recursive: true, force: true }); } };
}
async function pair(page: Page, hub: HubServer) {
  await page.goto(hub.url); await preparePairing(page, hub); await page.getByRole("button", { name: "配对此设备", exact: true }).click();
  await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
  await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" }); await showDisconnectedBots(page); await waitForClientOnline(page);
}
const workspace = (page: Page) => page.locator(".host-workspace:not([hidden])");
const feedback = (page: Page) => page.locator(".attachment-drop-feedback");
const tray = (scope: Locator) => scope.getByRole("region", { name: "待发送的附件", exact: true });
const pane = (page: Page, id: string) => page.locator(`.adhd-card[data-pane-conversation="${id}"]`);
const messages = async (hub: HubServer, id: string) => (await hub.store.snapshot("owner", id)).messages;
// Hold only the completion of one real draft read. The IDB transaction still
// finishes normally; this models a slow local refresh after returning from the
// file manager without delaying network traffic or adding a production hook.
async function holdFocusDraftRead(page: Page, conversationId: string) {
  await page.evaluate(id => {
    const original = IDBObjectStore.prototype.get;
    IDBObjectStore.prototype.get = function(key) {
      const request = original.call(this, key);
      if (this.name !== "conversationDrafts" || key !== id) return request;
      IDBObjectStore.prototype.get = original;
      const add = request.addEventListener.bind(request);
      request.addEventListener = ((type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions) => {
        add(type, type === "success" ? event => {
          (window as any).releaseFocusDraftRead = () => {
            delete (window as any).releaseFocusDraftRead;
            if (typeof listener === "function") listener.call(request, event); else listener.handleEvent(event);
          };
        } : listener, options);
      }) as typeof request.addEventListener;
      return request;
    };
    window.dispatchEvent(new Event("focus"));
  }, conversationId);
  await expect.poll(() => page.evaluate(() => typeof (window as any).releaseFocusDraftRead)).toBe("function");
}
async function replaceDraftFromOtherWindow(page: Page, conversationId: string) {
  return page.evaluate(async id => {
    for (const { name } of await indexedDB.databases()) {
      if (!name) continue;
      const db = await new Promise<IDBDatabase>((resolve, reject) => { const request = indexedDB.open(name); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
      try {
        if (!db.objectStoreNames.contains("conversationDrafts")) continue;
        const changed = await new Promise<boolean>((resolve, reject) => {
          const tx = db.transaction("conversationDrafts", "readwrite"), store = tx.objectStore("conversationDrafts"), request = store.get(id);
          let found = false;
          tx.oncomplete = () => resolve(found); tx.onerror = () => reject(tx.error);
          request.onsuccess = () => {
            const row = request.result;
            if (!row?.files.length) return;
            found = true;
            store.put({ ...row, revision: crypto.randomUUID(), files: ["foreign.txt", "foreign-second.txt"].map(name => ({ ...row.files[0], name })) }, id);
          };
        });
        if (changed) return true;
      } finally { db.close(); }
    }
    return false;
  }, conversationId);
}
// A disabled target names its reason and never offers to accept the files.
async function refused(page: Page, scope: Locator, reason: string) {
  await expect(feedback(page)).toContainText(reason); await expect(feedback(page)).not.toContainText("松开以添加附件");
  await expect(scope).not.toHaveClass(/is-file-drop-target/);
}

test("single chat: sidebar and header drops name the chat, draft the exact Files and upload identical bytes only on Send", async ({ page }) => {
  const env = await setup();
  try {
    await pair(page, env.hub); await selectConversation(page, env.first.title);
    const main = workspace(page).locator(".conversation-main"), composer = main.getByRole("textbox", { name: "消息", exact: true });
    await composer.fill("文字草稿保持不变");
    const drag = await osDrag(page), notes = { files: [env.file("notes.txt")] }, image = { files: [env.file("pixel.png")] };
    await drag.hover(workspace(page).locator(".sidebar"), notes);
    await expect(feedback(page)).toHaveAttribute("role", "status");
    await expect(feedback(page)).toContainText("松开以添加附件"); await expect(feedback(page)).toContainText(`添加到「${env.first.title}」`);
    await drag.drop(workspace(page).locator(".sidebar"), notes);
    await expect(feedback(page)).toHaveCount(0);
    await expect(tray(main)).toContainText("notes.txt"); await expect(composer).toHaveValue("文字草稿保持不变");
    await drag.hover(main.locator(".conversation-header"), image); await drag.drop(main.locator(".conversation-header"), image);
    await expect(tray(main)).toContainText("pixel.png");
    // Dropping only drafts. Nothing reaches the Hub until the user sends.
    expect(await messages(env.hub, env.first.id)).toHaveLength(0);
    await main.getByRole("button", { name: "发送消息", exact: true }).click(); await expect(tray(main)).toHaveCount(0);
    await expect.poll(async () => (await messages(env.hub, env.first.id)).length).toBe(1);
    const [message] = await messages(env.hub, env.first.id);
    expect(message!.blocks.some(block => block.type === "text" && block.text.includes("文字草稿保持不变"))).toBe(true);
    const uploaded = message!.blocks.flatMap(block => "attachmentId" in block ? [block] : []);
    expect(uploaded.map(block => block.type).sort()).toEqual(["file", "image"]);
    for (const block of uploaded) expect(await readFile((await env.hub.attachments.download({ userId: "owner" }, block.attachmentId)).path)).toEqual(block.type === "image" ? png : env.notes);
    expect(await messages(env.hub, env.second.id)).toHaveLength(0);
  } finally { await page.close(); await env.close(); }
});

test("a mixed drop keeps every real file, including zero bytes, and explains the skipped folder", async ({ page }) => {
  const env = await setup();
  try {
    await pair(page, env.hub); await selectConversation(page, env.first.title);
    const main = workspace(page).locator(".conversation-main"), drag = await osDrag(page);
    const data = { files: [env.file("notes.txt"), env.file("资料夹"), env.file("empty.bin"), env.file("pixel.png")] };
    await drag.hover(main.locator(".message-scroll"), data); await drag.drop(main.locator(".message-scroll"), data);
    for (const name of ["notes.txt", "empty.bin", "pixel.png"]) await expect(tray(main)).toContainText(name);
    // Chromium hands a directory to getAsFile() as an inode-sized File; it must not become an attachment.
    await expect(tray(main)).not.toContainText("资料夹");
    await expect(page.getByRole("alert").filter({ hasText: "暂不支持拖入文件夹" })).toBeVisible();
    const folderOnly = { files: [env.file("资料夹")] };
    await drag.hover(main.locator(".message-scroll"), folderOnly); await drag.drop(main.locator(".message-scroll"), folderOnly);
    await expect(page.getByRole("alert").filter({ hasText: "暂不支持拖入文件夹" })).toBeVisible();
    expect(await messages(env.hub, env.first.id)).toHaveLength(0);
  } finally { await page.close(); await env.close(); }
});

test("first multi-file drop during focus refresh is accepted once and still waits for the draft before Send", async ({ page }) => {
  const env = await setup();
  try {
    await pair(page, env.hub); await selectConversation(page, env.first.title);
    const main = workspace(page).locator(".conversation-main"), drag = await osDrag(page);
    await main.getByRole("textbox", { name: "消息", exact: true }).fill("retain this text");
    const send = main.getByRole("button", { name: "发送消息", exact: true });
    await expect(send).toBeEnabled();
    await holdFocusDraftRead(page, env.first.id);
    await expect(send).toBeDisabled();
    const data = { files: [env.file("notes.txt"), env.file("pixel.png"), env.file("说明.md")] };
    await drag.hover(main.locator(".message-scroll"), data);
    await expect(feedback(page)).toContainText("松开以添加附件");
    await drag.drop(main.locator(".message-scroll"), data);
    await expect(tray(main).locator(".attachment-draft-file")).toHaveCount(3);
    await expect(send).toBeDisabled();
    expect(await messages(env.hub, env.first.id)).toHaveLength(0);
    await page.evaluate(() => (window as any).releaseFocusDraftRead());
    await expect(send).toBeEnabled();
    await expect(tray(main).locator(".attachment-draft-file")).toHaveCount(3);
    await expect(main.getByRole("alert").filter({ hasText: "当前对话暂时无法添加附件" })).toHaveCount(0);
    await send.click();
    await expect(tray(main)).toHaveCount(0);
    await expect.poll(async () => (await messages(env.hub, env.first.id)).length).toBe(1);
    const [message] = await messages(env.hub, env.first.id);
    const uploaded = message!.blocks.flatMap(block => "attachmentId" in block ? [block] : []);
    expect(uploaded).toHaveLength(3);
    const bytes = await Promise.all(uploaded.map(async block => (await readFile((await env.hub.attachments.download({ userId: "owner" }, block.attachmentId)).path)).toString("base64")));
    expect(bytes.sort()).toEqual([png, env.notes, Buffer.from("third file bytes")].map(value => value.toString("base64")).sort());
  } finally { await page.close(); await env.close(); }
});

test("successful file intake clears its earlier drop rejection", async ({ page }) => {
  const env = await setup();
  try {
    await pair(page, env.hub); await selectConversation(page, env.first.title);
    const main = workspace(page).locator(".conversation-main"), drag = await osDrag(page), target = main.locator(".message-scroll");
    const folder = { files: [env.file("资料夹")] };
    await drag.hover(target, folder); await drag.drop(target, folder);
    const warning = page.getByRole("alert").filter({ hasText: "暂不支持拖入文件夹" });
    await expect(warning).toBeVisible();
    const files = { files: [env.file("notes.txt"), env.file("empty.bin")] };
    await drag.hover(target, files); await drag.drop(target, files);
    await expect(tray(main).locator(".attachment-draft-file")).toHaveCount(2);
    await expect(warning).toHaveCount(0);
    // A separate validation error must not disappear just because another
    // attachment was accepted; the zero-byte file still needs attention.
    await main.getByRole("button", { name: "发送消息", exact: true }).click();
    const sendWarning = page.getByRole("alert").filter({ hasText: "文件不能为空" });
    await expect(sendWarning).toBeVisible();
    const image = { files: [env.file("pixel.png")] };
    await drag.hover(target, image); await drag.drop(target, image);
    await expect(tray(main).locator(".attachment-draft-file")).toHaveCount(3);
    await expect(sendWarning).toBeVisible();
    expect(await messages(env.hub, env.first.id)).toHaveLength(0);
  } finally { await page.close(); await env.close(); }
});

test("removing a newly dropped file during refresh never removes another window's file", async ({ page }) => {
  const env = await setup();
  try {
    await pair(page, env.hub); await selectConversation(page, env.first.title);
    const main = workspace(page).locator(".conversation-main"), drag = await osDrag(page), target = main.locator(".message-scroll");
    const initial = { files: [env.file("notes.txt")] };
    await drag.hover(target, initial); await drag.drop(target, initial);
    await expect(tray(main)).toContainText("notes.txt");
    // The persisted list differs from the optimistic view before focus reload.
    await expect.poll(() => replaceDraftFromOtherWindow(page, env.first.id)).toBe(true);
    await holdFocusDraftRead(page, env.first.id);
    const additions = { files: [env.file("说明.md"), env.file("pixel.png")] };
    await drag.hover(target, additions); await drag.drop(target, additions);
    await tray(main).getByRole("button", { name: "移除 说明.md", exact: true }).click();
    await expect(tray(main).getByText("说明.md", { exact: true })).toHaveCount(0);
    await page.evaluate(() => (window as any).releaseFocusDraftRead());
    await expect(tray(main)).toContainText("foreign.txt");
    await expect(tray(main)).toContainText("foreign-second.txt");
    await expect(tray(main)).toContainText("pixel.png");
    await expect(tray(main).locator(".attachment-draft-file")).toHaveCount(3);
    await expect(tray(main).getByText("说明.md", { exact: true })).toHaveCount(0);
    await page.reload(); await waitForClientOnline(page); await selectConversation(page, env.first.title);
    await expect(tray(main)).toContainText("foreign-second.txt");
    await expect(tray(main).getByText("说明.md", { exact: true })).toHaveCount(0);
    expect(await messages(env.hub, env.first.id)).toHaveLength(0);
  } finally { await page.close(); await env.close(); }
});

test("an inline report or widget card in the chat does not block file drops", async ({ page }) => {
  const env = await setup();
  try {
    await env.hub.store.publishBotMessage("alpha", { id: "report_drop", conversationId: env.first.id, status: "complete", blocks: [widgetBlock({ title: "交付节奏", summary: "示例数据", report: { version: 1, columns: ["日期", "数量"], rows: [["10/27", 2], ["10/28", 3]] } })] });
    await pair(page, env.hub); await selectConversation(page, env.first.title);
    const main = workspace(page).locator(".conversation-main"), drag = await osDrag(page), data = { files: [env.file("notes.txt")] };
    await expect(main.locator("dialog.report-panel, dialog[open]").first()).toBeVisible();
    await drag.hover(main.locator(".composer"), data);
    await expect(feedback(page)).toContainText(`添加到「${env.first.title}」`);
    await drag.drop(main.locator(".composer"), data);
    await expect(tray(main)).toContainText("notes.txt");
  } finally { await page.close(); await env.close(); }
});

test("ADHD: only the exact pane receives files; board space and read-only panes take nothing", async ({ page }) => {
  const env = await setup();
  try {
    await pair(page, env.hub); await selectConversation(page, env.first.title);
    await page.getByRole("button", { name: "打开 ADHD 模式", exact: true }).click();
    for (const chat of [env.first, env.second]) await page.getByRole("checkbox", { name: `加入面板：测试主机 · ${chat.title}`, exact: true }).check();
    const left = pane(page, env.first.id), right = pane(page, env.second.id), drag = await osDrag(page), data = { files: [env.file("notes.txt")] };
    await expect(right.locator(".composer textarea")).toBeEnabled();
    await drag.hover(right.locator(".message-scroll"), data);
    await expect(feedback(page)).toContainText(`添加到「${env.second.title}」`);
    await drag.drop(right.locator(".message-scroll"), data);
    await expect(tray(right)).toContainText("notes.txt"); await expect(tray(left)).toHaveCount(0);
    // Outside every pane: a hint, never a fallback into the chat behind the board.
    const back = page.getByRole("button", { name: "返回聊天", exact: true });
    await drag.hover(back, data); await expect(feedback(page)).toContainText("请将文件拖到要发送的对话面板中。");
    await drag.drop(back, data);
    await expect(tray(left)).toHaveCount(0); await expect(tray(right).getByText("notes.txt")).toHaveCount(1);
    const device = (await env.hub.store.db.all<{ id: string }>("SELECT id FROM devices WHERE id != 'pairing_fixture_owner'"))[0]!.id;
    await env.hub.auth.revoke(device, "local-owner");
    await expect(left.getByRole("alert").filter({ hasText: "此设备已被吊销" })).toBeVisible({ timeout: 15000 });
    await drag.hover(left.locator(".message-scroll"), data); await refused(page, left.locator(".conversation-main"), "当前为只读模式，无法添加附件。");
    await drag.drop(left.locator(".message-scroll"), data);
    await expect(tray(left)).toHaveCount(0); await expect(tray(right).getByText("notes.txt")).toHaveCount(1);
  } finally { await page.close(); await env.close(); }
});

test("modal ownership: Settings blocks the chat behind it, while the QR scanner still receives its image", async ({ page }, info) => {
  const env = await setup();
  try {
    await pair(page, env.hub); await selectConversation(page, env.first.title);
    const main = workspace(page).locator(".conversation-main"), drag = await osDrag(page), notes = { files: [env.file("notes.txt")] };
    const qr = env.file("pairing.png");
    await writeFile(qr, await QRCode.toBuffer(pairingLink({ v: 1, kind: "approve", hubPublicKey: env.hub.auth.publicKey, code: "12345678" })));
    await openSettings(page, "devices");
    const settings = page.getByRole("navigation", { name: "设置分类" });
    await drag.hover(settings, notes); await expect(feedback(page)).toContainText("请先关闭弹窗，再添加附件。");
    // The hint lives inside the top-layer dialog, on screen and announced there.
    await expect(page.locator("dialog:modal .attachment-drop-feedback")).toBeVisible(); await expect(feedback(page)).toBeInViewport({ ratio: 1 });
    await page.screenshot({ path: info.outputPath("settings-modal-drop-hint.png") });
    await drag.drop(settings, notes);
    await openDevicePairing(page); await page.getByRole("button", { name: "扫描新设备配对码", exact: true }).click();
    const scanner = page.locator("dialog.pairing-scanner");
    await expect(scanner).toBeVisible();
    const image = { files: [qr] };
    await drag.hover(scanner.getByRole("heading").first(), image);
    // The scanner owns this gesture: no chat feedback competes with it.
    await expect(feedback(page)).toHaveCount(0);
    await drag.drop(scanner.getByRole("heading").first(), image);
    await expect(page.getByLabel("新设备配对码", { exact: true })).toHaveValue("12345678");
    await expect(scanner).toHaveCount(0);
    await closeDevicePairing(page); await closeSettings(page);
    await expect(page.getByRole("navigation", { name: "设置分类" })).toHaveCount(0);
    await expect(tray(main)).toHaveCount(0);
    expect(await messages(env.hub, env.first.id)).toHaveLength(0);
  } finally { await page.close(); await env.close(); }
});

test("leaving the window or cancelling with Escape clears feedback, and the next gesture works", async ({ page }) => {
  const env = await setup();
  try {
    await pair(page, env.hub); await selectConversation(page, env.first.title);
    const main = workspace(page).locator(".conversation-main"), drag = await osDrag(page), data = { files: [env.file("notes.txt")] };
    await drag.hover(main.locator(".message-scroll"), data); await expect(feedback(page)).toContainText("松开以添加附件");
    await expect(main).toHaveClass(/is-file-drop-target/);
    await drag.leaveWindow(data);
    await expect(feedback(page)).toHaveCount(0); await expect(main).not.toHaveClass(/is-file-drop-target/);
    // Without the dragover heartbeat (removed node, silent OS cancel) decoration fades,
    // but the captured target survives: the next dragover restores the same chat.
    await drag.hover(main.locator(".message-scroll"), data); await expect(feedback(page)).toBeVisible();
    await drag.stall(); await page.waitForTimeout(1600);
    await expect(feedback(page)).toHaveCount(0); await expect(main).not.toHaveClass(/is-file-drop-target/);
    await drag.move(main.locator(".message-scroll"), data); await expect(feedback(page)).toContainText(`添加到「${env.first.title}」`);
    // An OS cancel can end without dragleave; Escape is the user's way out of stale feedback.
    await drag.cancel(data); await page.keyboard.press("Escape");
    await expect(feedback(page)).toHaveCount(0); await expect(main).not.toHaveClass(/is-file-drop-target/);
    await expect(tray(main)).toHaveCount(0);
    // CDP's cancel leaves Chromium's drag target in place, so no fresh dragenter
    // follows. A real user moves the pointer before starting another OS drag.
    await page.mouse.move(8, 8);
    // A later, separate gesture must not inherit the cancelled one.
    await drag.hover(main.locator(".message-scroll"), data); await expect(feedback(page)).toContainText(`添加到「${env.first.title}」`);
    await drag.drop(main.locator(".message-scroll"), data); await expect(tray(main)).toContainText("notes.txt");
  } finally { await page.close(); await env.close(); }
});

test("switching chats mid-gesture cancels it, keeps both drafts and never retargets the files", async ({ page }) => {
  const env = await setup();
  try {
    await pair(page, env.hub); await selectConversation(page, env.first.title);
    const main = workspace(page).locator(".conversation-main"), composer = main.getByRole("textbox", { name: "消息", exact: true });
    await composer.fill("切换前的草稿");
    const drag = await osDrag(page), data = { files: [env.file("notes.txt")] };
    await drag.hover(main.locator(".message-scroll"), data); await expect(feedback(page)).toContainText(`添加到「${env.first.title}」`);
    await workspace(page).locator(".sidebar").getByText(env.second.title, { exact: true }).first().evaluate((node: HTMLElement) => node.click());
    await expect(main.locator(".conversation-header h1")).toHaveText(env.second.title);
    await drag.move(main.locator(".message-scroll"), data);
    await expect(feedback(page)).toContainText("对话已切换，拖放已取消，请重新拖入文件。");
    await drag.drop(main.locator(".message-scroll"), data);
    await expect(tray(main)).toHaveCount(0);
    await selectConversation(page, env.first.title);
    await expect(tray(main)).toHaveCount(0); await expect(composer).toHaveValue("切换前的草稿");
    for (const chat of [env.first, env.second]) expect(await messages(env.hub, chat.id)).toHaveLength(0);
    // After the cancelled gesture ends, a new one targets the chat now shown.
    await drag.hover(main.locator(".message-scroll"), data); await expect(feedback(page)).toContainText(`添加到「${env.first.title}」`);
    await drag.drop(main.locator(".message-scroll"), data); await expect(tray(main)).toContainText("notes.txt");
  } finally { await page.close(); await env.close(); }
});

test("text and link drags stay ordinary: no feedback, no attachment, the composer receives the text", async ({ page }) => {
  const env = await setup();
  try {
    await pair(page, env.hub); await selectConversation(page, env.first.title);
    const main = workspace(page).locator(".conversation-main"), composer = main.getByRole("textbox", { name: "消息", exact: true }), drag = await osDrag(page);
    const text = { items: [{ mimeType: "text/plain", data: "普通文字拖动" }] };
    await drag.hover(main.locator(".message-scroll"), text); await expect(feedback(page)).toHaveCount(0);
    await expect(main).not.toHaveClass(/is-file-drop-target/);
    await drag.drop(composer, text);
    await expect(composer).toHaveValue(/普通文字拖动/); await expect(tray(main)).toHaveCount(0);
    await composer.fill("");
    const link = { items: [{ mimeType: "text/uri-list", data: "https://example.com/drop" }, { mimeType: "text/plain", data: "https://example.com/drop" }] };
    await drag.hover(composer, link); await expect(feedback(page)).toHaveCount(0);
    await drag.drop(composer, link);
    await expect(composer).toHaveValue(/example\.com\/drop/); await expect(tray(main)).toHaveCount(0);
    expect(new URL(page.url()).origin).toBe(new URL(env.hub.url).origin);
  } finally { await page.close(); await env.close(); }
});

test("while a send is still uploading, drops are refused visibly and nothing is lost; the next drop works", async ({ page }) => {
  const env = await setup();
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  let held!: () => void; const holding = new Promise<void>(resolve => { held = resolve; });
  try {
    await pair(page, env.hub); await selectConversation(page, env.first.title);
    const main = workspace(page).locator(".conversation-main"), composer = main.getByRole("textbox", { name: "消息", exact: true });
    const drag = await osDrag(page), notes = { files: [env.file("notes.txt")] }, image = { files: [env.file("pixel.png")] };
    await drag.hover(main.locator(".message-scroll"), notes); await drag.drop(main.locator(".message-scroll"), notes);
    await expect(tray(main)).toContainText("notes.txt");
    await page.route("**/api/uploads/*/complete", async route => { held(); await gate; await route.continue(); });
    await composer.fill("附件发送中"); await main.getByRole("button", { name: "发送消息", exact: true }).click();
    await holding;
    await page.mouse.move(8, 8);
    await drag.hover(main.locator(".message-scroll"), image); await refused(page, main, "正在上传附件，请完成后再添加。");
    await drag.drop(main.locator(".message-scroll"), image);
    await expect(tray(main)).not.toContainText("pixel.png");
    release();
    await expect.poll(async () => (await messages(env.hub, env.first.id)).length).toBe(1);
    const [message] = await messages(env.hub, env.first.id);
    const uploaded = message!.blocks.flatMap(block => "attachmentId" in block ? [block] : []);
    expect(uploaded.map(block => block.type)).toEqual(["file"]);
    expect(await readFile((await env.hub.attachments.download({ userId: "owner" }, uploaded[0]!.attachmentId)).path)).toEqual(env.notes);
    await expect(tray(main)).toHaveCount(0);
    await page.mouse.move(8, 8);
    await drag.hover(main.locator(".message-scroll"), image); await expect(feedback(page)).toContainText(`添加到「${env.first.title}」`);
    await drag.drop(main.locator(".message-scroll"), image); await expect(tray(main)).toContainText("pixel.png");
  } finally { release(); await page.close(); await env.close(); }
});

test("a side panel without attachment support refuses its own drops and never falls through to the main chat", async ({ page }) => {
  const env = await setup(), stateDir = path.join(env.root, "bot"); await mkdir(stateDir, { recursive: true });
  await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ engine: "codex", locale: "zh" }));
  const secret = randomBytes(32).toString("base64url");
  await env.hub.store.db.run("INSERT INTO bots(id,name,secret_hash,engine) VALUES('side','侧边助手',?,'codex')", [hashSecret(secret)]);
  const chat = await env.hub.store.createConversation("owner", ["side"], "侧边拖放", "drop-side");
  const gateway = await attachGateway({ stateDir, url: env.hub.instanceUrl.replace("http", "ws") + "/instance", botId: "side", secret, engine: "codex", runtime: createCoreServiceRuntime({}), bridge: {
    handleAuthorizedMessage: async () => ({ text: "主对话回复" }),
    sideCapability: () => ({ context: "native", concurrent: true, readOnly: "enforced", residue: "none", seesInProgressTurn: false }),
    openSideSession: async () => ({ nativeId: "side_drop", dispose: async () => undefined, send: async () => ({ text: "侧边回复" }) }),
  } as never });
  try {
    await pair(page, env.hub); await selectConversation(page, chat.title);
    await page.getByRole("button", { name: "侧边对话", exact: true }).click();
    const panel = page.getByRole("complementary", { name: "侧边对话", exact: true }), main = workspace(page).locator(".conversation-main");
    await expect(panel.getByRole("button", { name: "添加侧边附件", exact: true })).toBeDisabled();
    const drag = await osDrag(page), data = { files: [env.file("notes.txt")] };
    await drag.hover(panel.getByRole("textbox", { name: "侧边问题", exact: true }), data);
    await refused(page, main, "当前无法添加侧边附件，请等待连接或上传完成。");
    await drag.drop(panel.getByRole("textbox", { name: "侧边问题", exact: true }), data);
    await expect(tray(panel)).toHaveCount(0); await expect(tray(main)).toHaveCount(0);
    await page.mouse.move(8, 8);
    await drag.hover(main.locator(".message-scroll"), data); await expect(feedback(page)).toContainText(`添加到「${chat.title}」`);
    await drag.drop(main.locator(".message-scroll"), data);
    await expect(tray(main)).toContainText("notes.txt"); await expect(tray(panel)).toHaveCount(0);
  } finally { await page.close(); await gateway.disconnect(); await env.close(); }
});

test("a text-only send waiting for its durable outbox receipt refuses drops with the sending reason", async ({ page }) => {
  // Same receipt hold as adhd-board "pending text send": Connection.send resolves after the outbox write.
  await page.addInitScript(() => {
    const put = IDBObjectStore.prototype.put;
    const controls = { hold: false, held: 0, release: () => {} }; Object.assign(window, { sendReceipts: controls });
    let queued: (() => void)[] = [];
    controls.release = () => { controls.hold = false; const all = queued; queued = []; for (const run of all) run(); };
    IDBObjectStore.prototype.put = function(value, key) {
      const request = put.call(this, value, key);
      if (this.name === "outbox" && controls.hold) {
        const add = request.addEventListener.bind(request);
        request.addEventListener = ((type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions) => {
          if (type === "success") add(type, event => {
            const run = () => typeof listener === "function" ? listener.call(request, event) : listener.handleEvent(event);
            if (controls.hold) { controls.held++; queued.push(run); } else run();
          }, options); else add(type, listener, options);
        }) as typeof request.addEventListener;
      }
      return request;
    };
  });
  const env = await setup();
  const receipts = () => page.evaluate(() => (window as unknown as { sendReceipts: { held: number } }).sendReceipts.held);
  const release = () => page.evaluate(() => (window as unknown as { sendReceipts: { release: () => void } }).sendReceipts.release());
  try {
    await pair(page, env.hub); await selectConversation(page, env.first.title);
    const main = workspace(page).locator(".conversation-main"), composer = main.getByRole("textbox", { name: "消息", exact: true });
    const drag = await osDrag(page), data = { files: [env.file("notes.txt")] };
    await composer.fill("只有文字的消息");
    await page.evaluate(() => { (window as unknown as { sendReceipts: { hold: boolean } }).sendReceipts.hold = true; });
    await main.getByRole("button", { name: "发送消息", exact: true }).click();
    await expect.poll(receipts).toBeGreaterThan(0);
    await drag.hover(main.locator(".message-scroll"), data); await refused(page, main, "正在发送，请完成后再添加附件。");
    await drag.drop(main.locator(".message-scroll"), data);
    await expect(tray(main)).toHaveCount(0);
    await release();
    await expect.poll(async () => (await messages(env.hub, env.first.id)).length).toBe(1);
    expect((await messages(env.hub, env.first.id))[0]!.blocks.some(block => "attachmentId" in block)).toBe(false);
    await page.mouse.move(8, 8);
    await drag.hover(main.locator(".message-scroll"), data); await expect(feedback(page)).toContainText(`添加到「${env.first.title}」`);
    await drag.drop(main.locator(".message-scroll"), data); await expect(tray(main)).toContainText("notes.txt");
  } finally { await release().catch(() => undefined); await page.close(); await env.close(); }
});

test("WebViews without :modal still separate inline cards from real modals and keep QR ownership", async ({ page }) => {
  // Emulate a WebView that rejects the :modal selector. Every selector API
  // throws for :modal only, and the count proves the fallback actually ran.
  await page.addInitScript(() => {
    const state = { throws: 0 }; Object.assign(window, { modalSelectorThrows: state });
    const reject = (selector: unknown) => { if (typeof selector === "string" && selector.includes(":modal")) { state.throws++; throw new DOMException(`'${selector}' is not a valid selector.`, "SyntaxError"); } };
    for (const proto of [Element.prototype, Document.prototype, DocumentFragment.prototype] as Record<string, unknown>[]) {
      for (const name of ["matches", "closest", "querySelector", "querySelectorAll"]) {
        const original = proto[name] as ((this: unknown, selector: string) => unknown) | undefined;
        if (typeof original === "function" && Object.prototype.hasOwnProperty.call(proto, name)) proto[name] = function(this: unknown, selector: string) { reject(selector); return original.call(this, selector); };
      }
    }
  });
  const env = await setup();
  const throws = () => page.evaluate(() => (window as unknown as { modalSelectorThrows: { throws: number } }).modalSelectorThrows.throws);
  try {
    await env.hub.store.publishBotMessage("alpha", { id: "report_compat", conversationId: env.first.id, status: "complete", blocks: [widgetBlock({ title: "交付节奏", summary: "示例数据", report: { version: 1, columns: ["日期", "数量"], rows: [["10/27", 2], ["10/28", 3]] } })] });
    await pair(page, env.hub); await selectConversation(page, env.first.title);
    const main = workspace(page).locator(".conversation-main"), drag = await osDrag(page), notes = { files: [env.file("notes.txt")] };
    // A collapsed inline report is an open, non-modal dialog: drops still reach the chat.
    await expect(main.locator("dialog.report-panel")).toBeVisible();
    await drag.hover(main.locator(".composer"), notes); await expect(feedback(page)).toContainText(`添加到「${env.first.title}」`);
    await drag.drop(main.locator(".composer"), notes); await expect(tray(main)).toContainText("notes.txt");
    expect(await throws()).toBeGreaterThan(0);
    // The expanded report is modal: the chat behind it refuses, with the hint inside that dialog.
    await main.getByRole("button", { name: "放大交互组件", exact: true }).first().click();
    const report = page.locator("dialog.report-panel").filter({ has: page.getByRole("button", { name: "收起交互组件", exact: true }) });
    await expect(report).toBeVisible();
    await page.mouse.move(8, 8);
    await drag.hover(report, notes); await expect(feedback(page)).toContainText("请先关闭弹窗，再添加附件。");
    await expect(report.locator(".attachment-drop-feedback")).toBeVisible(); await expect(feedback(page)).toBeInViewport({ ratio: 1 });
    await drag.drop(report, notes);
    await report.getByRole("button", { name: "收起交互组件", exact: true }).click(); await expect(report).toHaveCount(0);
    await expect(tray(main).getByText("notes.txt")).toHaveCount(1);
    // Settings is a real modal; its hint is portalled into it.
    await openSettings(page, "devices");
    const settings = page.getByRole("navigation", { name: "设置分类" });
    await page.mouse.move(8, 8);
    await drag.hover(settings, notes); await expect(feedback(page)).toContainText("请先关闭弹窗，再添加附件。");
    await expect(page.locator("dialog.preferences-dialog .attachment-drop-feedback")).toBeVisible(); await expect(feedback(page)).toBeInViewport({ ratio: 1 });
    await drag.drop(settings, notes);
    // The QR scanner still owns its image under the fallback.
    const qr = env.file("pairing.png");
    await writeFile(qr, await QRCode.toBuffer(pairingLink({ v: 1, kind: "approve", hubPublicKey: env.hub.auth.publicKey, code: "12345678" })));
    await openDevicePairing(page); await page.getByRole("button", { name: "扫描新设备配对码", exact: true }).click();
    const scanner = page.locator("dialog.pairing-scanner"); await expect(scanner).toBeVisible();
    const image = { files: [qr] };
    await drag.hover(scanner.getByRole("heading").first(), image); await expect(feedback(page)).toHaveCount(0);
    await drag.drop(scanner.getByRole("heading").first(), image);
    await expect(page.getByLabel("新设备配对码", { exact: true })).toHaveValue("12345678"); await expect(scanner).toHaveCount(0);
    await closeDevicePairing(page); await closeSettings(page);
    await expect(tray(main).getByText("notes.txt")).toHaveCount(1); await expect(tray(main)).not.toContainText("pairing.png");
    expect(await messages(env.hub, env.first.id)).toHaveLength(1);
  } finally { await page.close(); await env.close(); }
});
