import { preparePairing } from "./fixtures/pairing-invite.js";
import { clickAppAction } from "./fixtures/desktop-actions.js";
import { showDisconnectedBots, enterMobileChat, mobileChatAction } from "./fixtures/mobile.js";
import { waitForClientOnline } from "./fixtures/mobile.js";
import { test, expect, type Page } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HubServer } from "../../src/hub/server.js";
import { HubError } from "../../src/hub/store.js";
import { hashSecret } from "../../src/hub/auth.js";
import { attachGateway } from "../../src/gateway/service.js";
import { createCoreServiceRuntime } from "../../src/core/runtime.js";

test.use({ serviceWorkers: "block", actionTimeout: 15_000 });
async function pair(page: Page, hub: HubServer) {
  await page.goto(hub.url); await preparePairing(page, hub); await page.getByRole("button", { name: "配对此设备", exact: true }).click();
  await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
  await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" });
  await waitForClientOnline(page);
}
async function send(page: Page, text: string) { await page.getByRole("textbox", { name: "消息", exact: true }).fill(text); await page.getByRole("button", { name: "发送消息", exact: true }).click(); }

test("conversation mute updates both connected devices without reopening settings", async ({ browser }) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mute-sync-ui-"));
  const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve("dist") });
  const contexts = await Promise.all([browser.newContext(), browser.newContext()]);
  const pages = await Promise.all(contexts.map((context) => context.newPage()));
  let release!: () => void, captured = false, returned = false;
  const held = new Promise<void>((resolve) => { release = resolve; });
  try {
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','助手','fixture')");
    const conversation = await hub.store.createConversation("owner", ["alpha"], "免打扰同步", "mute");
    for (const page of pages) await pair(page, hub);
    await pages[0]!.route("**/api/notifications", async (route) => {
      if (captured) { await route.continue(); return; }
      const response = await route.fetch(); captured = true;
      await held; await route.fulfill({ response }); returned = true;
    });
    for (const page of pages) await clickAppAction(page, "对话设置", page.getByRole("button", { name: "对话设置", exact: true }));
    await expect.poll(() => captured).toBe(true);
    await pages[0]!.getByRole("checkbox", { name: "此对话免打扰", exact: true }).click();
    for (const page of pages) await expect(page.getByRole("checkbox", { name: "此对话免打扰", exact: true })).toBeChecked();
    release(); await expect.poll(() => returned).toBe(true);
    // This late pre-mute GET must not replace either the live UI or the
    // notification policy used by the connection for desktop alerts.
    await expect(pages[0]!.getByRole("checkbox", { name: "此对话免打扰", exact: true })).toBeChecked();
    await pages[1]!.getByRole("checkbox", { name: "此对话免打扰", exact: true }).click();
    for (const page of pages) await expect(page.getByRole("checkbox", { name: "此对话免打扰", exact: true })).not.toBeChecked();
    expect((await hub.store.db.get<{ muted: number }>("SELECT muted FROM conversation_members WHERE conversation_id=? AND member_type='user'", [conversation.id]))?.muted).toBe(0);
  } finally { release(); for (const context of contexts) await context.close(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});

test("foreground route probes do not repeatedly reload the conversation's message history", async ({ page }) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "idle-cache-"));
  const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve("dist") });
  let probes = 0;
  page.on("request", (request) => { if (new URL(request.url()).pathname === "/health") probes++; });
  try {
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','助手','fixture')");
    const c = await hub.store.createConversation("owner", ["alpha"], "空闲检查", "idle");
    await hub.store.publishBotMessage("alpha", { conversationId: c.id, blocks: [{ type: "text", text: "已有历史仍然可读" }] });
    await page.addInitScript(() => {
      Object.assign(window, { messageReads: 0 });
      const get = IDBIndex.prototype.getAll;
      IDBIndex.prototype.getAll = function (...args: Parameters<typeof get>) { if (this.objectStore.name === "messages") (window as unknown as { messageReads: number }).messageReads++; return get.apply(this, args); };
    });
    await page.goto(hub.url); await preparePairing(page, hub); await page.getByRole("button", { name: "配对此设备", exact: true }).click();
    await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
    await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" });
    await expect(page.locator(".message-body").getByText("已有历史仍然可读", { exact: true })).toBeVisible();
    await page.waitForTimeout(300); const previousProbes = probes;
    await page.evaluate(() => { (window as unknown as { messageReads: number }).messageReads = 0; });
    // Healthy routes probe every 120 seconds; foregrounding requests the same
    // health refresh immediately without advancing heartbeat clocks artificially.
    await page.waitForTimeout(1600);
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect.poll(() => probes).toBeGreaterThan(previousProbes);
    expect(await page.evaluate(() => (window as unknown as { messageReads: number }).messageReads)).toBe(0);
  } finally { await hub.close(); await rm(root, { recursive: true, force: true }); }
});

test("a phone can clear a broken recovery selection, then reset; desktop sees the same state", async ({ browser }, info) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "binding-recovery-ui-")), stateDir = path.join(root, "bot"); await mkdir(stateDir);
  await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ engine: "codex", locale: "zh" }));
  const hub = await HubServer.start({ stateDir: path.join(root, "hub"), clientDir: path.resolve("dist") });
  const secret = randomBytes(32).toString("base64url"); await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','研究助手',?)", [hashSecret(secret)]);
  let calls = 0;
  const gateway = await attachGateway({ stateDir, url: hub.instanceUrl.replace("http", "ws") + "/instance", botId: "alpha", secret, runtime: createCoreServiceRuntime(), bridge: { handleAuthorizedMessage: async () => { calls++; return { text: "恢复操作后可正常对话" }; } } });
  const desktopContext = await browser.newContext(), phoneContext = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const desktop = await desktopContext.newPage(), phone = await phoneContext.newPage();
  try {
    const c = await hub.store.createConversation("owner", ["alpha"], "故障恢复", "recover"); await hub.store.updateConversation("owner", c.id, { sessionId: "removed_native" });
    await pair(desktop, hub); await pair(phone, hub); await enterMobileChat(phone, c.title);
    await clickAppAction(desktop, "对话设置", desktop.getByRole("button", { name: "对话设置", exact: true }));
    await expect(desktop.getByRole("button", { name: "高级对话管理", exact: true })).toHaveAttribute("aria-expanded", "false");
    await desktop.getByRole("button", { name: "关闭对话设置", exact: true }).click();
    await send(desktop, "不能错误地交给其他上下文");
    for (const page of [desktop, phone]) await expect(page.locator(".message-blocks").last()).toContainText("本条消息未交给模型");
    expect(calls).toBe(0);
    await clickAppAction(desktop, "对话设置", desktop.getByRole("button", { name: "对话设置", exact: true }));
    await mobileChatAction(phone, "对话设置");
    for (const device of [desktop, phone]) await device.getByRole("button", { name: "高级对话管理", exact: true }).click();
    await expect(phone.getByText("清除只取消恢复选择，不撤销已发生的切换。恢复曾中断时，请先切断或重置会话，再发消息。", { exact: true })).toBeVisible();
    await phone.screenshot({ path: info.outputPath("binding-recovery-phone.png"), fullPage: true });
    await phone.getByRole("button", { name: "清除会话选择", exact: true }).click();
    await phone.getByRole("dialog", { name: "清除会话选择", exact: true }).getByRole("button", { name: "确认", exact: true }).click();
    for (const page of [desktop, phone]) await expect(page.getByRole("button", { name: "清除会话选择", exact: true })).toHaveCount(0);
    expect((await hub.store.conversations("owner"))[0]).not.toHaveProperty("sessionId");
    await phone.getByRole("button", { name: "重新开始上下文", exact: true }).click();
    await phone.getByRole("dialog", { name: "重新开始上下文", exact: true }).getByRole("button", { name: "确认", exact: true }).click();
    await expect.poll(async () => (await hub.store.snapshot("owner", c.id)).messages.some(message => message.authorType === "user" && message.blocks.some(block => block.type === "text" && block.text === "/reset"))).toBe(true);
    await expect.poll(async () => (await hub.store.pendingForBot("alpha")).length).toBe(0); expect(calls).toBe(0);
    await desktop.getByRole("button", { name: "关闭对话设置", exact: true }).click();
    await phone.getByRole("button", { name: "返回聊天", exact: true }).click();
    await send(phone, "继续正常对话");
    for (const page of [desktop, phone]) await expect(page.locator(".message-scroll").getByText("恢复操作后可正常对话", { exact: true })).toBeVisible();
    expect(calls).toBe(1); await desktop.screenshot({ path: info.outputPath("binding-recovery-desktop.png") });
  } finally { await desktopContext.close(); await phoneContext.close(); await gateway.disconnect(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});

test("bounded retries survive reload, preserve conversation order and let another conversation progress", async ({ page }, info) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "outbox-review-ui-"));
  const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve("dist") });
  let attempts = 0, fail = true, sockets = 0; page.on("websocket", (socket) => { if (new URL(socket.url()).pathname === "/ws") sockets++; });
  try {
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','助手','fixture')");
    const first = await hub.store.createConversation("owner", ["alpha"], "顺序对话", "first"), other = await hub.store.createConversation("owner", ["alpha"], "其他对话", "other");
    const original = hub.store.sendMessage.bind(hub.store);
    hub.store.sendMessage = async (userId, input) => {
      if (input.text === "首先发送") { attempts++; if (fail) throw new HubError("temporary_storage_error", 503); }
      if (input.text === "已损坏的附件") throw new HubError("attachment_unavailable", 410);
      return original(userId, input);
    };
    await pair(page, hub); await showDisconnectedBots(page); const initialSockets = sockets; await page.locator(".conversation-row").filter({ hasText: "顺序对话" }).click();
    await send(page, "首先发送"); await send(page, "其次发送");
    await page.locator(".conversation-row").filter({ hasText: "其他对话" }).click(); await send(page, "独立对话正常发送");
    await expect.poll(async () => (await hub.store.snapshot("owner", other.id)).messages.length).toBe(1);
    await page.locator(".conversation-row").filter({ hasText: "顺序对话" }).click();
    await expect(page.getByRole("button", { name: "重试", exact: true })).toBeVisible({ timeout: 15_000 });
    expect(attempts).toBe(4); expect(sockets).toBe(initialSockets); expect((await hub.store.snapshot("owner", first.id)).messages).toHaveLength(0);
    await expect(page.getByText("等待前一条消息处理", { exact: true })).toBeVisible();
    await page.screenshot({ path: info.outputPath("outbox-actionable-failure.png") });
    await page.reload(); await waitForClientOnline(page);
    await page.locator(".conversation-row").filter({ hasText: "顺序对话" }).click();
    await expect(page.getByRole("button", { name: "重试", exact: true })).toBeVisible(); expect(attempts).toBe(4); expect(sockets).toBe(initialSockets + 1);
    fail = false; await page.getByRole("button", { name: "重试", exact: true }).click();
    await expect.poll(async () => (await hub.store.snapshot("owner", first.id)).messages.length).toBe(2);
    expect((await hub.store.snapshot("owner", first.id)).messages.map((m) => m.blocks[0])).toEqual([{ type: "text", text: "首先发送" }, { type: "text", text: "其次发送" }]);
    expect(attempts).toBe(5); await expect(page.locator(".queued-message")).toHaveCount(0);
    await send(page, "已损坏的附件"); await send(page, "移除后继续");
    await expect(page.getByRole("button", { name: "移除待发送项", exact: true })).toBeVisible();
    await expect(page.getByText("等待前一条消息处理", { exact: true })).toBeVisible();
    expect((await hub.store.snapshot("owner", first.id)).messages).toHaveLength(2);
    await page.getByRole("button", { name: "移除待发送项", exact: true }).click();
    await expect.poll(async () => (await hub.store.snapshot("owner", first.id)).messages.length).toBe(3);
    await expect(page.locator(".queued-message")).toHaveCount(0); expect(sockets).toBe(initialSockets + 1);
    // A rejected card action shares this outbox and must also expose a way to
    // unblock the conversation, rather than leaving an invisible failed head.
    hub.store.enqueueAction = async () => { throw new HubError("interaction_expired", 410); };
    await hub.store.publishBotMessage("alpha", { conversationId: first.id, blocks: [{ type: "card", title: "操作测试", elements: [{ type: "button", text: "失效测试按钮", actionId: "review_fail", value: {} }] }] });
    await page.getByRole("button", { name: "失效测试按钮", exact: true }).click();
    await expect(page.locator(".queued-message").filter({ hasText: "卡片操作" })).toBeVisible();
    await send(page, "卡片操作失败后的消息"); await expect(page.getByText("等待前一条消息处理", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "移除待发送项", exact: true }).click();
    await expect.poll(async () => (await hub.store.snapshot("owner", first.id)).messages.length).toBe(5);
    await expect(page.locator(".queued-message")).toHaveCount(0);
    await page.setViewportSize({ width: 390, height: 844 });
    await send(page, "已损坏的附件"); await expect(page.getByRole("button", { name: "移除待发送项", exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath("outbox-actionable-failure-phone.png") });
  } finally { await hub.close(); await rm(root, { recursive: true, force: true }); }
});

test("group session controls target one Bot and keep the composer recipient consistent", async ({ page }, info) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "target-bot-ui-"));
  const hub = await HubServer.start({ stateDir: path.join(root, "hub"), clientDir: path.resolve("dist") });
  const gateways: Awaited<ReturnType<typeof attachGateway>>[] = [];
  try {
    for (const id of ["alpha", "beta"]) {
      const stateDir = path.join(root, id); await mkdir(stateDir); await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ engine: "codex", locale: "zh" }));
      const secret = randomBytes(32).toString("base64url"); await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES(?,?,?)", [id, id === "alpha" ? "研究助手" : "代码助手", hashSecret(secret)]);
      gateways.push(await attachGateway({ stateDir, url: hub.instanceUrl.replace("http", "ws") + "/instance", botId: id, secret, runtime: createCoreServiceRuntime(), bridge: { handleAuthorizedMessage: async () => ({ text: id }) } }));
    }
    const c = await hub.store.createConversation("owner", ["alpha", "beta"], "共同项目", "group", { type: "group" });
    await pair(page, hub); await showDisconnectedBots(page); const botOrder = await page.locator(".bot-tree").evaluateAll((items) => items.map((e) => e.getAttribute("data-bot-id")));
    await clickAppAction(page, "对话设置", page.getByRole("button", { name: "对话设置", exact: true })); await page.getByLabel("操作的 Bot", { exact: true }).selectOption("beta");
    await expect(page.getByText("当前操作对象：此对话中的 代码助手", { exact: true })).toBeVisible();
    await page.screenshot({ path: info.outputPath("target-bot-controls.png") });
    await page.getByRole("button", { name: "高级对话管理", exact: true }).click();
    await page.getByRole("button", { name: "更多恢复方式", exact: true }).click();
    await expect.poll(async () => (await hub.store.snapshot("owner", c.id)).messages.filter((m) => m.authorType === "bot").length).toBe(1);
    expect((await hub.store.snapshot("owner", c.id)).messages.filter((m) => m.authorType === "bot").map((m) => m.authorId)).toEqual(["beta"]);
    await send(page, "选择后的下一条消息");
    await expect(page.locator(".message-blocks").getByText("beta", { exact: true })).toBeVisible();
    expect((await hub.store.snapshot("owner", c.id)).messages.some((m) => m.authorType === "bot" && m.authorId === "alpha")).toBe(false);
    await gateways[0]!.disconnect();
    await expect(page.locator('.bot-tree[data-bot-id="alpha"] i.online')).toHaveCount(0);
    await expect(page.locator(".group-tree .conversation-row i.online")).toHaveCount(1);
    expect(await page.locator(".bot-tree").evaluateAll((items) => items.map((e) => e.getAttribute("data-bot-id")))).toEqual(botOrder);
    await clickAppAction(page, "对话设置", page.getByRole("button", { name: "对话设置", exact: true })); await page.getByLabel("操作的 Bot", { exact: true }).selectOption("beta");
    await page.getByRole("button", { name: "新建独立对话", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "新建对话", exact: true });
    await expect(dialog.getByRole("checkbox", { name: /代码助手/ })).toBeChecked(); await expect(dialog.getByRole("checkbox", { name: /研究助手/ })).not.toBeChecked();
  } finally { for (const gateway of gateways) await gateway.disconnect(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});

for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
  test(`unavailable card stays local and does not stall chat at ${viewport.width}px`, async ({ page }, info) => {
    await page.setViewportSize(viewport);
    const root = await mkdtemp(path.join(os.tmpdir(), "expired-card-ui-"));
    const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve("dist") });
    let attempts = 0;
    try {
      await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','助手','fixture')");
      const c = await hub.store.createConversation("owner", ["alpha"], "过期卡片", "expired-card");
      // Return the same terminal rejection as a disabled/removed action. Other
      // failure codes retain the ordering coverage in the preceding test.
      hub.store.enqueueAction = async () => { attempts++; throw new HubError("action_unavailable", 409); };
      await hub.store.publishBotMessage("alpha", { conversationId: c.id, blocks: [{ type: "card", title: "旧卡片", elements: [{ type: "button", text: "旧操作", actionId: "old", value: {} }] }] });
      const openChat = async () => {
        if (viewport.width < 760) { await showDisconnectedBots(page); await enterMobileChat(page, c.title); }
        else { await showDisconnectedBots(page); await page.locator(".conversation-row").filter({ hasText: c.title }).click(); }
      };
      await pair(page, hub); await openChat();
      await page.getByRole("button", { name: "旧操作", exact: true }).click();
      const row = page.locator(".queued-message").filter({ hasText: "卡片操作" });
      await expect(row).toContainText("此卡片操作已失效，请查看最新卡片。");
      await expect(row.getByRole("button", { name: "重试", exact: true })).toHaveCount(0);
      await expect(page.locator(".error-banner")).toHaveCount(0);
      await send(page, "失效操作之后仍可发送");
      await expect.poll(async () => (await hub.store.snapshot("owner", c.id)).messages.filter(m => m.authorType === "user").length).toBe(1);
      await expect(page.getByText("等待前一条消息处理", { exact: true })).toHaveCount(0);
      await page.reload(); await waitForClientOnline(page); await openChat();
      await expect(row).toContainText("此卡片操作已失效，请查看最新卡片。");
      await expect(row.getByRole("button", { name: "重试", exact: true })).toHaveCount(0);
      await expect(page.locator(".error-banner")).toHaveCount(0);
      expect(attempts).toBe(1);
      await page.screenshot({ path: info.outputPath(`expired-card-${viewport.width}.png`) });
      await row.getByRole("button", { name: "移除待发送项", exact: true }).click();
      await expect(row).toHaveCount(0);
      await expect(page.locator(".error-banner")).toHaveCount(0);
      expect((await hub.store.snapshot("owner", c.id)).messages).toHaveLength(2);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    } finally { await hub.close(); await rm(root, { recursive: true, force: true }); }
  });
}
