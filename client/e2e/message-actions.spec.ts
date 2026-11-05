import { preparePairing } from "./fixtures/pairing-invite.js";
import { clickAppAction } from "./fixtures/desktop-actions.js";
import { showDisconnectedBots, selectConversation } from "./fixtures/mobile.js";
import { waitForClientOnline } from "./fixtures/mobile.js";
import { test, expect, type Page } from "@playwright/test";
import { messageAction, holdMessage } from './fixtures/message-actions.js';
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { HubServer } from "../../src/hub/server.js";

async function pair(page: Page, hub: HubServer, url = hub.url) {
  await page.goto(hub.url); if (url !== hub.url) await page.getByLabel("Hub 地址", { exact: true }).fill(url); await preparePairing(page, hub); await page.getByRole("button", { name: "配对此设备", exact: true }).click();
  await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
  await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" }); await showDisconnectedBots(page); await waitForClientOnline(page);
}
async function select(page: Page, title: string, parentTitle?: string) { await selectConversation(page, title, parentTitle); }
const article = (page: Page, id: string) => page.locator(`[data-message-id="${id}"]`);

test("phone message sheet preserves source, draft, focus and native Back across live changes", async ({ browser }, info) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "message-sheet-"));
  const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve("dist") });
  // This test intentionally mocks the export HTTP response. In WebKit a service
  // worker-owned fetch bypasses page.route; offline/SW behavior is covered below.
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, serviceWorkers: "block" });
  const page = await context.newPage(), errors: string[] = [];
  let releaseExport: () => void = () => undefined;
  page.on("pageerror", e => errors.push(e.message));
  try {
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','助手','fixture')");
    const source = await hub.store.createConversation("owner", ["alpha"], "消息操作验收", "source");
    const other = await hub.store.createConversation("owner", ["alpha"], "另一个对话", "other");
    const message = await hub.store.publishBotMessage("alpha", { conversationId: source.id, blocks: [{ type: "text", text: "准确复制这一条 **原始 Markdown**" }] });
    await hub.store.publishBotMessage("alpha", { conversationId: source.id, blocks: [{ type: "text", text: "相邻消息不会遮住上一条的操作按钮。" }] });
    await pair(page, hub); await select(page, source.title);
    await page.evaluate(() => {
      Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (text: string) => {
        if ((window as any).rejectCopy) throw new Error("clipboard-denied");
        (window as any).copied = text;
      } } });
    });
    const composer = page.getByRole("textbox", { name: "消息", exact: true });
    const trigger = article(page, message.id);
    const sheet = page.getByRole("dialog", { name: "消息操作", exact: true });
    const back = () => page.evaluate(() => !window.dispatchEvent(new Event("tarocub-native-back", { cancelable: true })));
    let exports = 0;
    const exportBodies: unknown[] = [], exportGate = new Promise<void>(resolve => { releaseExport = resolve; });
    await page.route("**/api/gdocs/export", async route => {
      exports++; exportBodies.push(route.request().postDataJSON()); await exportGate;
      await route.fulfill({ status: exports === 1 ? 503 : 200, contentType: "application/json", body: JSON.stringify(exports === 1 ? { error: "fixture-export-unavailable" } : { url: "https://docs.google.com/document/d/fixture_export/edit" }) });
    });
    await composer.fill("保留这份草稿");
    await expect(article(page, message.id).getByRole("button", { name: "复制消息", exact: true })).toBeHidden();
    await expect(trigger.getByRole("button", { name: "消息操作", exact: true })).toHaveCount(0);
    // The message itself remains reachable by hardware keyboards and assistive activation.
    await trigger.focus(); await page.keyboard.press("Enter"); await expect(sheet).toBeVisible();
    expect(await back()).toBe(true); await expect(sheet).toBeHidden();
    await expect(trigger).toBeFocused(); await expect(composer).toHaveValue("保留这份草稿");
    await messageAction(page, article(page, message.id), "复制消息");
    await expect.poll(() => page.evaluate(() => (window as any).copied)).toBe("准确复制这一条 **原始 Markdown**");
    await expect(article(page, message.id).getByText("已复制", { exact: true })).toBeVisible();
    if (await sheet.isVisible()) await page.keyboard.press("Escape");
    await messageAction(page, article(page, message.id), "引用回复");
    await expect(sheet).toBeHidden(); await expect(composer).toBeFocused();
    await expect(composer).toHaveValue("保留这份草稿");
    await expect(page.locator(".reply-preview")).toContainText("准确复制这一条");
    await page.getByRole("button", { name: "取消引用", exact: true }).click();
    await messageAction(page, article(page, message.id), "转发消息");
    const forwarding = page.getByRole("dialog", { name: "转发消息", exact: true });
    await expect(forwarding).toBeVisible(); await expect(sheet).toBeHidden();
    expect(await back()).toBe(true); await expect(forwarding).toBeHidden();
    await expect(composer).toHaveValue("保留这份草稿");
    expect(await page.evaluate(() => document.activeElement !== document.body && !!document.activeElement?.isConnected && !document.activeElement?.closest("dialog"))).toBe(true);

    await page.evaluate(() => { (window as any).rejectCopy = true; });
    await messageAction(page, article(page, message.id), "复制消息");
    await expect(page.getByRole("alert")).toContainText(/无法写入剪贴板|复制失败/);
    if (await sheet.isVisible()) await page.keyboard.press("Escape");
    expect(exports).toBe(0); // Opening/closing a menu must not create a cloud document.
    await messageAction(page, article(page, message.id), "导出到 Google 文档");
    await expect.poll(() => exports).toBe(1);
    await page.keyboard.press("Escape"); await holdMessage(page, trigger);
    await expect(sheet.getByRole("button", { name: "导出到 Google 文档", exact: true })).toBeDisabled();
    expect(exportBodies).toEqual([{ messageId: message.id }]);
    await page.setViewportSize({ width: 1360, height: 900 });
    await expect(sheet).toBeHidden();
    await expect(article(page, message.id).getByRole("button", { name: "导出到 Google 文档", exact: true })).toBeDisabled();
    await page.setViewportSize({ width: 390, height: 844 }); await holdMessage(page, trigger);
    await expect(sheet.getByRole("button", { name: "导出到 Google 文档", exact: true })).toBeDisabled();
    releaseExport();
    await expect(sheet.getByRole("alert")).toContainText(/Google 文档导出未完成/);
    expect(exports).toBe(1);
    await sheet.getByRole("button", { name: "导出到 Google 文档", exact: true }).click();
    await expect(sheet.getByRole("link", { name: "打开 Google 文档", exact: true })).toHaveAttribute("href", "https://docs.google.com/document/d/fixture_export/edit");
    await page.keyboard.press("Escape"); await holdMessage(page, trigger);
    await expect(sheet.getByRole("link", { name: "打开 Google 文档", exact: true })).toBeVisible();
    expect(exports).toBe(2);
    await page.keyboard.press("Escape");

    await holdMessage(page, trigger);
    await page.evaluate(id => window.dispatchEvent(new CustomEvent("tarocub-navigate", { detail: { conversationId: id } })), other.id);
    await expect(page.getByRole("heading", { name: other.title, exact: true })).toBeVisible();
    await expect(sheet).toBeHidden();
    await select(page, source.title); await expect(composer).toHaveValue("保留这份草稿");
    await holdMessage(page, trigger); await page.setViewportSize({ width: 1360, height: 900 });
    await expect(sheet).toBeHidden();
    await article(page, message.id).hover();
    await expect(article(page, message.id).getByRole("button", { name: "引用回复", exact: true })).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    await holdMessage(page, trigger);
    await hub.store.publishBotMessage("alpha", { id: message.id, conversationId: source.id, blocks: [], status: "deleted" });
    await expect(article(page, message.id)).toHaveCount(0);
    if (await sheet.isVisible()) {
      await expect(sheet.getByRole("status")).toContainText("这条消息已不在当前对话中");
      await expect(sheet.getByRole("button", { name: "转发消息", exact: true })).toHaveCount(0);
      await page.keyboard.press("Escape");
    }
    await expect(sheet).toBeHidden();
    await expect(composer).toHaveValue("保留这份草稿");
    await page.screenshot({ path: info.outputPath("message-source-removed.png") });
    expect(exports).toBe(2); expect(errors).toEqual([]);
  } finally { releaseExport(); await context.close(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});

test("quotes and rich forwards work in both directions across independently paired desktop and phone", async ({ browser }, info) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "message-actions-"));
  const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve("dist") });
  const desktopContext = await browser.newContext({ viewport: { width: 1360, height: 900 } }), phoneContext = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const desktop = await desktopContext.newPage(), phone = await phoneContext.newPage();
  try {
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','产品助手','fixture')");
    const source = await hub.store.createConversation("owner", ["alpha"], "方案讨论", "source");
    const group = await hub.store.createConversation("owner", ["alpha"], "产品工作群", "group", { type: "group" });
    const topic = await hub.store.createConversation("owner", [], "界面设计", "topic", { parentId: group.id });
    const other = await hub.store.createConversation("owner", ["alpha"], "新对话", "other");
    const old = await hub.store.createConversation("owner", ["alpha"], "已结束的工作", "old"); await hub.store.updateConversation("owner", old.id, { archived: true });
    const body = "布局方案\n用户消息使用浅蓝色。\n完整附件内容。", data = Buffer.from(body);
    const attachmentId = await hub.attachments.importForBot("alpha", { conversationId: source.id, name: "界面说明.txt", mime: "text/plain", size: data.length, sha256: createHash("sha256").update(data).digest("hex") }, data);
    const original = await hub.store.publishBotMessage("alpha", { conversationId: source.id, blocks: [{ type: "text", text: '### 下周天气与行程摘要\n\n| 日期 | 天气 | 温度 |\n| --- | --- | --- |\n| 周一 | 晴 | 17–26°C |\n| 周二 | 多云 | 18–25°C |\n| 周三 | 小雨 | 16–23°C |\n\n**出行建议**\n\n- 随身携带薄外套。\n- 文件包含完整行程，可引用后继续讨论。\n\n```js\nconst forecast = "sunny";\n```\n\n[外部资料](https://example.com/weather) ![远程图片](https://example.com/tracker.png)' }, { type: "file", attachmentId, name: "界面说明.txt", mime: "text/plain", size: data.length }, { type: "card", title: "方案确认", elements: [{ type: "button", text: "采用这个方案", actionId: "approve" }] }] });
    await pair(desktop, hub); await pair(phone, hub); await select(desktop, source.title); await select(phone, source.title);
    await messageAction(phone, article(phone, original.id), '引用回复');
    await expect(phone.locator(".reply-preview")).toContainText("回复 产品助手"); await expect(phone.locator(".reply-preview")).toContainText("界面说明.txt");
    const draftPreview = phone.locator(".reply-preview");
    await expect(draftPreview.locator("table")).toContainText("17–26°C");
    await expect(draftPreview.locator("table th")).toHaveCount(3);
    await expect(draftPreview.locator("a, .code-copy")).toHaveCount(0);
    await draftPreview.getByRole("button", { name: "展开预览", exact: true }).click();
    await expect(draftPreview.locator("ul li")).toHaveCount(2);
    await expect(draftPreview.locator("pre code")).toHaveText('const forecast = "sunny";\n');
    await draftPreview.getByRole("button", { name: "收起预览", exact: true }).click();
    await phone.screenshot({ path: info.outputPath("rich-quote-draft-phone.png"), fullPage: true });
    await phone.getByRole("button", { name: "取消引用", exact: true }).click(); await expect(phone.locator(".reply-preview")).toHaveCount(0);
    await messageAction(phone, article(phone, original.id), '引用回复');
    await phone.getByRole("textbox", { name: "消息", exact: true }).fill("就按这个方案继续"); await phone.getByRole("button", { name: "发送消息", exact: true }).click();
    await expect(desktop.locator(".message-blocks").getByText("就按这个方案继续", { exact: true })).toBeVisible();
    const quote = (await hub.store.snapshot("owner", source.id)).messages.find((m) => m.authorType === "user")!; expect(quote.replyTo).toBe(original.id);
    await expect(article(desktop, quote.id).locator(".message-reference table")).toContainText("17–26°C");
    await expect(article(desktop, quote.id).locator(".rich-preview-attachment")).toContainText("界面说明.txt");
    await desktop.screenshot({ path: info.outputPath("rich-quote-desktop.png"), fullPage: true });
    await article(desktop, quote.id).getByRole("button", { name: "查看引用原消息", exact: true }).click(); await expect(article(desktop, original.id)).toHaveClass(/focused-message/);
    await article(desktop, original.id).getByRole("button", { name: "转发消息", exact: true }).click();
    let dialog = desktop.getByRole("dialog", { name: "转发消息", exact: true });
    await expect(dialog.locator(".rich-message-preview, .forward-preview")).toHaveCount(0);
    await expect(dialog).not.toContainText("17–26°C");
    await expect(dialog.getByRole("button", { name: old.title, exact: true })).toHaveCount(0);
    await expect(dialog.getByRole("button", { name: other.title, exact: true })).toBeVisible();
    await expect(dialog.getByRole("button", { name: group.title, exact: true })).toBeVisible();
    await dialog.getByRole("textbox", { name: "搜索转发目标", exact: true }).fill("工作群");
    await dialog.getByRole("button", { name: "产品工作群 / 界面设计", exact: true }).click();
    await expect(dialog.getByRole("checkbox", { name: "让 Bot 回复这条转发", exact: true })).not.toBeChecked();
    await desktop.screenshot({ path: info.outputPath("forward-picker-desktop.png"), fullPage: true });
    await dialog.getByRole("button", { name: "确认转发", exact: true }).click();
    await expect(desktop.getByRole("heading", { name: topic.title, exact: true })).toBeVisible(); await select(phone, topic.title, group.title);
    await expect(phone.getByRole("button", { name: "查看转发来源", exact: true })).toContainText("转发自 产品助手");
    const forwarded = (await hub.store.snapshot("owner", topic.id)).messages[0]!; expect(forwarded.forwardedFrom?.messageId).toBe(original.id);
    expect((await hub.store.pendingForBot("alpha")).some((m) => m.id === forwarded.id)).toBe(false);
    for (const page of [desktop, phone]) {
      await expect(article(page, forwarded.id).getByRole("button", { name: "采用这个方案", exact: true })).toBeDisabled();
      const file = article(page, forwarded.id).getByRole("region", { name: "界面说明.txt", exact: true });
      await file.getByRole("button", { name: /^预览(?: |$)/ }).click(); await expect(page.getByRole("dialog", { name: "文件预览" }).locator("pre")).toHaveText(body); await page.keyboard.press("Escape");
      const download = page.waitForEvent("download"); await file.getByRole("button", { name: "另存为 界面说明.txt", exact: true }).click(); expect(await readFile((await (await download).path())!, "utf8")).toBe(body);
    }
    await desktop.screenshot({ path: info.outputPath("forwarded-desktop.png"), fullPage: true });
    await phone.screenshot({ path: info.outputPath("forwarded-phone.png"), fullPage: true });
    await messageAction(phone, article(phone, forwarded.id), '转发消息'); dialog = phone.getByRole("dialog", { name: "转发消息", exact: true });
    await dialog.getByRole("textbox", { name: "搜索转发目标", exact: true }).fill(other.title); await dialog.getByRole("button", { name: other.title, exact: true }).click();
    await dialog.getByRole("checkbox", { name: "让 Bot 回复这条转发", exact: true }).check();
    await phone.screenshot({ path: info.outputPath("forward-picker-phone.png"), fullPage: true });
    await dialog.getByRole("button", { name: "确认转发", exact: true }).click(); await select(desktop, other.title);
    await expect(desktop.getByRole("button", { name: "查看转发来源", exact: true })).toContainText("产品工作群 / 界面设计");
    const again = (await hub.store.snapshot("owner", other.id)).messages[0]!; expect(again.forwardedFrom?.messageId).toBe(forwarded.id); expect(again.mentions).toEqual(["alpha"]);
    expect((await hub.store.pendingForBot("alpha")).some((m) => m.id === again.id)).toBe(true);
    await desktop.reload(); await select(desktop, other.title); await expect(article(desktop, again.id)).toBeVisible();
    await article(desktop, again.id).getByRole("button", { name: "查看转发来源", exact: true }).click(); await expect(article(desktop, forwarded.id)).toHaveClass(/focused-message/);
    await hub.store.publishBotMessage("alpha", { id: original.id, conversationId: source.id, blocks: [], status: "deleted" });
    await expect.poll(async () => (await hub.store.snapshot("owner", topic.id)).messages[0]).toEqual(forwarded);
    await article(desktop, forwarded.id).getByRole("button", { name: "查看转发来源", exact: true }).click(); await expect(desktop.getByRole("alert")).toContainText("原消息已删除或当前不可访问");
    expect(((await hub.store.devices("owner")).filter(device => device.id !== "pairing_fixture_owner"))).toHaveLength(2);
  } finally { await desktopContext.close(); await phoneContext.close(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});

test("offline forwarding survives reload and sends exactly once after the socket recovers", async ({ page }) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "offline-forward-")); const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve("dist") });
  let online = true; const sockets = new Set<net.Socket>();
  const proxy = net.createServer((client) => {
    const upstream = net.connect(Number(new URL(hub.url).port), "127.0.0.1"); sockets.add(client); sockets.add(upstream);
    client.on("error", () => upstream.destroy()); upstream.on("error", () => client.destroy());
    client.on("close", () => { sockets.delete(client); upstream.destroy(); }); upstream.on("close", () => { sockets.delete(upstream); client.destroy(); });
    if (online) { client.pipe(upstream); upstream.pipe(client); }
  });
  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve)); const url = `http://127.0.0.1:${(proxy.address() as net.AddressInfo).port}`;
  try {
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','助手','fixture')");
    const source = await hub.store.createConversation("owner", ["alpha"], "来源", "source"), target = await hub.store.createConversation("owner", ["alpha"], "接收", "target");
    const message = await hub.store.publishBotMessage("alpha", { conversationId: source.id, blocks: [{ type: "text", text: "断线时也能转发" }] });
    await pair(page, hub, url); await select(page, source.title); online = false; for (const socket of sockets) socket.destroy();
    await expect(page.locator(".offline-banner")).toBeVisible();
    await article(page, message.id).getByRole("button", { name: "转发消息", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "转发消息", exact: true }); await dialog.getByRole("button", { name: target.title, exact: true }).click(); await dialog.getByRole("button", { name: "确认转发", exact: true }).click();
    await expect(page.locator(".queued-message")).toContainText("等待发送"); expect((await hub.store.snapshot("owner", target.id)).messages).toHaveLength(0);
    // The UI bundle remains available (as in a native shell); only the Hub route is cut.
    // Reload must retain the queued frame in IndexedDB while that route is offline.
    await page.reload({ waitUntil: "domcontentloaded" }); await select(page, target.title); await expect(page.locator(".queued-message")).toContainText("转发消息");
    online = true; for (const socket of sockets) socket.destroy();
    await waitForClientOnline(page); await select(page, target.title);
    await expect(page.locator(".message-blocks").getByText("断线时也能转发", { exact: true })).toBeVisible(); await expect(page.locator(".queued-message")).toHaveCount(0);
    await page.reload(); await select(page, target.title); await expect(page.getByRole("button", { name: "查看转发来源", exact: true })).toBeVisible();
    expect((await hub.store.snapshot("owner", target.id)).messages).toHaveLength(1);
  } finally { await page.close(); for (const socket of sockets) socket.destroy(); await new Promise<void>((resolve) => proxy.close(() => resolve())); await hub.close(); await rm(root, { recursive: true, force: true }); }
});

test("phone message actions use current streaming and archive constraints", async ({ browser }) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "message-sheet-live-"));
  const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve("dist") });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true });
  const desktopContext = await browser.newContext({ viewport: { width: 1360, height: 900 } });
  const desktop = await desktopContext.newPage();
  const page = await context.newPage();
  try {
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','助手','fixture')");
    const conversation = await hub.store.createConversation("owner", ["alpha"], "状态更新", "source");
    const message = await hub.store.publishBotMessage("alpha", { conversationId: conversation.id, blocks: [{ type: "text", text: "正在生成" }], status: "streaming" });
    await pair(page, hub); await select(page, conversation.title);
    await pair(desktop, hub); await select(desktop, conversation.title);
    const trigger = article(page, message.id);
    const sheet = page.getByRole("dialog", { name: "消息操作", exact: true });
    await holdMessage(page, trigger); await expect(sheet.getByRole("button", { name: "转发消息", exact: true })).toBeDisabled();
    await hub.store.publishBotMessage("alpha", { id: message.id, conversationId: conversation.id, blocks: [{ type: "text", text: "完整的最终内容" }], status: "complete" });
    await expect(article(page, message.id)).toContainText("完整的最终内容");
    if (!(await sheet.isVisible())) await holdMessage(page, trigger);
    await expect(sheet.getByRole("button", { name: "转发消息", exact: true })).toBeEnabled();
    await sheet.getByRole("button", { name: "引用回复", exact: true }).click();
    await expect(page.locator(".reply-preview")).toContainText("完整的最终内容");
    await page.getByRole("button", { name: "取消引用", exact: true }).click();
    await holdMessage(page, trigger);
    await clickAppAction(desktop, "对话设置", desktop.getByRole("button", { name: "对话设置", exact: true }));
    await desktop.getByRole("button", { name: "归档对话", exact: true }).click();
    await expect(page.getByRole("textbox", { name: "消息", exact: true })).toBeHidden();
    if (!(await sheet.isVisible())) await holdMessage(page, trigger);
    await expect(sheet.getByRole("button", { name: "引用回复", exact: true })).toBeDisabled();
    await page.keyboard.press("Escape");
  } finally { await context.close(); await desktopContext.close(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});

test("compact desktop messages keep actions reachable without shifting adjacent rows", async ({ page, browserName }, info) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "compact-messages-"));
  const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve("dist") });
  try {
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('bot','KIMI 测试助手','fixture')");
    const chat = await hub.store.createConversation("owner", ["bot"], "紧凑对话", "compact");
    const first = (await hub.store.sendMessage("owner", { conversationId: chat.id, clientMsgId: "reset", text: "/reset", attachments: [] })).message;
    await hub.store.publishBotMessage("bot", { conversationId: chat.id, blocks: [{ type: "text", text: "当前聊天的会话已重置。" }] });
    const second = (await hub.store.sendMessage("owner", { conversationId: chat.id, clientMsgId: "usage", text: "/usage", attachments: [] })).message;
    await hub.store.publishBotMessage("bot", { conversationId: chat.id, blocks: [{ type: "text", text: "累计用量（本实例）：\n• 可计量请求数：0\n• 未返回 token 明细的请求：5\n说明：未上报的数据不会算作零。" }] });
    await pair(page, hub); await select(page, chat.title);
    const rows = page.locator(".message-scroll .message"), composer = page.getByRole("textbox", { name: "消息", exact: true });
    await expect(rows).toHaveCount(4);
    const layout = () => rows.evaluateAll(nodes => nodes.map(node => {
      const row = node.getBoundingClientRect(), content = node.querySelector(".message-blocks")!.getBoundingClientRect();
      const meta = node.querySelector(".message-meta")!.getBoundingClientRect();
      return { id: (node as HTMLElement).dataset.messageId, top: row.top, height: row.height, bottom: content.bottom, metaTop: meta.top };
    }));
    for (const width of [1360, 800]) {
      await page.setViewportSize({ width, height: 900 });
      for (const palette of ["white-blue", "cli"]) {
        await page.evaluate(async palette => {
          document.documentElement.dataset.palette = palette;
          document.documentElement.dataset.theme = palette === "cli" ? "dark" : "light";
          await document.fonts.ready;
        }, palette);
        await composer.focus(); await page.mouse.move(1, 1);
        await expect.poll(async () => {
          const items = await layout();
          // After changing the viewport/theme, wait for react-virtual to apply
          // the new row heights before checking that hover/focus moves nothing.
          return items.slice(1).every((row, i) => row.metaTop - items[i]!.bottom >= 8 && row.metaTop - items[i]!.bottom <= 16
            && Math.abs(row.top - items[i]!.top - items[i]!.height) <= 1);
        }).toBe(true);
        const before = await layout();
        for (const row of await rows.all()) {
          await row.hover();
          const actions = row.locator(".message-actions");
          await expect(actions).toHaveCSS("opacity", "1");
          expect(await actions.evaluate(element => {
            const meta = element.parentElement!.getBoundingClientRect();
            const content = element.closest(".message-body")!.querySelector(".message-blocks")!.getBoundingClientRect();
            const buttons = [...element.querySelectorAll("button")];
            return buttons.every(button => {
              const box = button.getBoundingClientRect();
              return box.top >= meta.top && box.bottom <= content.top && box.left >= meta.left && box.right <= meta.right
                && button.contains(document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2));
            });
          })).toBe(true);
          // Actual keyboard navigation, not a programmatic pointer-focus restore.
          await page.mouse.move(1, 1); await row.focus();
          await page.keyboard.press(browserName === "webkit" && process.platform === "darwin" ? "Alt+Tab" : "Tab");
          await expect(actions).toHaveCSS("opacity", "1");
          await expect(row.getByRole("button", { name: "复制消息", exact: true })).toBeFocused();
        }
        expect(await layout()).toEqual(before);
        await info.attach(`spacing-${width}-${palette}`, { body: JSON.stringify(before), contentType: "application/json" });
        await page.screenshot({ path: info.outputPath(`compact-${width}-${palette}.png`) });
      }
    }
    // The relocated toolbar must still quote the intended user message.
    await article(page, first.id).getByRole("button", { name: "引用回复", exact: true }).click();
    await expect(page.locator(".reply-preview")).toContainText("/reset");
    await page.getByRole("button", { name: "取消引用", exact: true }).click();
    await article(page, second.id).getByRole("button", { name: "引用回复", exact: true }).click();
    await expect(page.locator(".reply-preview")).toContainText("/usage");
  } finally { await page.close(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});
