import { preparePairing } from "./fixtures/pairing-invite.js";
import { clickAppAction, revealReplyBots, dismissReplyBots } from "./fixtures/desktop-actions.js";
import { waitForClientOnline, selectConversation, enterMobileChat, mobileChatAction, mobileHome, openMobileHome, isPhone } from "./fixtures/mobile.js";
import { singleHostCacheName } from "./fixtures/cache.js";
import { test, expect, type Page } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HubServer } from "../../src/hub/server.js";
import { hashSecret } from "../../src/hub/auth.js";
import { attachGateway } from "../../src/gateway/service.js";
import { createCoreServiceRuntime } from "../../src/core/runtime.js";
import { messageSchema, type Message } from "../../src/client-protocol/index.js";
import { normalizeCodexMcpElicitation } from "../../src/codex/codex-mcp-elicitation.js";
import type { EngineApprovalRequest } from "../../src/codex/adapter.js";

async function pair(page: Page, hub: HubServer, name: string) {
  await page.goto(hub.url);
  await page.getByLabel("设备名称", { exact: true }).fill(name);
  await preparePairing(page, hub); await page.getByRole("button", { name: "配对此设备", exact: true }).click();
  await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
  await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" });
  await waitForClientOnline(page);
}
async function send(page: Page, text: string, replyBot?: string) {
  // Ordinary groups now record unmentioned messages without invoking a Bot.
  // Select the recipient explicitly when the journey expects an echo reply.
  if (replyBot) {
    await revealReplyBots(page);
    await page.getByRole("checkbox", { name: replyBot, exact: true }).check();
    await dismissReplyBots(page);
  }
  await page.getByRole("textbox", { name: "消息", exact: true }).fill(text);
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
}
async function select(page: Page, title: string, parentTitle?: string) {
  await selectConversation(page, title, parentTitle);
}

test("approval buttons and receipts show the native scope on both devices", async ({ browser }, info) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cross-device-scopes-")), stateDir = path.join(root, "instance");
  await mkdir(stateDir); await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ engine: "codex", locale: "zh" }));
  const hub = await HubServer.start({ stateDir: path.join(root, "hub"), clientDir: path.resolve("dist") });
  const secret = randomBytes(32).toString("base64url");
  await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','权限助手',?)", [hashSecret(secret)]);
  const scenarios: { request: EngineApprovalRequest; label: string; absent: string[]; resolved: string; scope: string }[] = [
    { request: { engine: "codex", toolName: "读取验收文件", toolInput: { path: "fixture.txt" }, approvalScopes: { once: "once", session: "session" } }, label: "本会话允许", absent: ["本轮允许"], resolved: "已允许本会话。", scope: "session" },
    { request: { engine: "antigravity", toolName: "执行本轮任务", toolInput: { task: "本地验收" }, approvalScopes: { once: "turn" } }, label: "本轮允许", absent: ["允许一次", "本会话允许"], resolved: "已允许本轮。", scope: "once" },
    { request: { engine: "kimi", toolName: "持续权限验收", toolInput: { command: "fixture" }, approvalScopes: { session: "always" } }, label: "允许后续调用", absent: ["允许一次", "本轮允许", "本会话允许"], resolved: "已按引擎的持续授权选项允许后续调用。", scope: "session" },
  ];
  const decisions: unknown[] = []; let index = 0;
  const gateway = await attachGateway({ stateDir, url: hub.instanceUrl.replace("http", "ws") + "/instance", botId: "alpha", secret, engine: "codex", runtime: createCoreServiceRuntime(), bridge: { handleAuthorizedMessage: async (input) => {
    const current = index++;
    decisions.push(await input.onApprovalRequest?.(scenarios[current]!.request));
    return { text: `权限验收完成 ${current}` };
  } } });
  await hub.store.createConversation("owner", ["alpha"], "权限范围验收", "scopes");
  const desktopContext = await browser.newContext(), phoneContext = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const desktop = await desktopContext.newPage(), phone = await phoneContext.newPage();
  try {
    await pair(desktop, hub, "权限电脑"); await pair(phone, hub, "权限手机"); await enterMobileChat(phone, "权限范围验收");
    for (const [i, scenario] of scenarios.entries()) {
      await send(desktop, `权限验收 ${i}`);
      for (const device of [desktop, phone]) {
        await expect(device.getByRole("button", { name: scenario.label, exact: true })).toBeVisible();
        for (const name of scenario.absent) await expect(device.getByRole("button", { name, exact: true })).toHaveCount(0);
      }
      if (i === 0) await phone.screenshot({ path: info.outputPath("session-scope-phone.png") });
      await phone.getByRole("button", { name: scenario.label, exact: true }).click();
      for (const device of [desktop, phone]) {
        await expect(device.locator(".message-body").getByText(`权限验收完成 ${i}`, { exact: true })).toBeVisible();
        await expect(device.locator(".message-body").getByText(`✅ ${scenario.resolved}`, { exact: true })).toBeVisible();
        await expect(device.getByRole("button", { name: scenario.label, exact: true })).toHaveCount(0);
      }
      expect(decisions[i]).toEqual({ behavior: "allow", scope: scenario.scope });
    }
  } finally { await desktopContext.close(); await phoneContext.close(); await gateway.disconnect(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});

test("Codex finite-choice and text-only MCP fields submit once from a phone", async ({ browser }) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cross-device-codex-form-")), stateDir = path.join(root, "instance");
  await mkdir(stateDir); await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ engine: "codex", locale: "zh" }));
  const hub = await HubServer.start({ stateDir: path.join(root, "hub"), clientDir: path.resolve("dist") });
  const secret = randomBytes(32).toString("base64url");
  await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','表单助手',?)", [hashSecret(secret)]);
  const replies: unknown[] = [];
  const form = normalizeCodexMcpElicitation({ threadId: "test-thread", turnId: "test-turn", serverName: "fixture", mode: "form", message: "选择与填写", requestedSchema: { type: "object", properties: {
    color: { type: "string", oneOf: [{ const: "blue", title: "蓝色" }, { const: "green", title: "绿色" }] },
    note: { type: "string", title: "说明" },
  }, required: ["color", "note"] } })!;
  const gateway = await attachGateway({ stateDir, url: hub.instanceUrl.replace("http", "ws") + "/instance", botId: "alpha", secret, engine: "codex", runtime: createCoreServiceRuntime(), bridge: { handleAuthorizedMessage: async (input) => {
    replies.push(form.response((await input.onApprovalRequest?.({ engine: "codex", toolName: "AskUserQuestion", toolInput: form.toolInput })) ?? { behavior: "deny" }));
    return { text: "已收到手机表单" };
  } } });
  await hub.store.createConversation("owner", ["alpha"], "跨端表单", "form");
  const desktopContext = await browser.newContext(), phoneContext = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const desktop = await desktopContext.newPage(), phone = await phoneContext.newPage();
  try {
    await pair(desktop, hub, "表单电脑"); await pair(phone, hub, "表单手机"); await enterMobileChat(phone, "跨端表单");
    await send(desktop, "打开表单");
    for (const page of [desktop, phone]) {
      await expect(page.getByRole("radio", { name: "蓝色", exact: true })).toBeVisible();
      await expect(page.locator('textarea[name="q0_other"]')).toHaveCount(0);
      await expect(page.locator('select[name="q1"]')).toHaveCount(0);
      await page.getByRole("button", { name: "第 2 题：fixture · 说明", exact: true }).click(); await expect(page.locator('textarea[name="q1_other"]')).toBeVisible(); await page.getByRole("button", { name: "上一题", exact: true }).click();
    }
    await phone.getByRole("radio", { name: "蓝色", exact: true }).check(); await phone.getByRole("button", { name: "下一题", exact: true }).click();
    await phone.locator('textarea[name="q1_other"]').fill("手机填写");
    await phone.getByRole("button", { name: "提交", exact: true }).click();
    for (const page of [desktop, phone]) {
      await expect(page.locator(".message-body").getByText("已收到手机表单", { exact: true })).toBeVisible();
      await expect(page.getByRole("button", { name: "提交", exact: true })).toHaveCount(0);
    }
    expect(replies).toEqual([{ action: "accept", content: { color: "blue", note: "手机填写" } }]);
  } finally { await desktopContext.close(); await phoneContext.close(); await gateway.disconnect(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});
async function cachedMessages(page: Page, conversationId: string): Promise<Message[]> {
  return (await page.evaluate(async ({id, databaseName}) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => { const request = indexedDB.open(databaseName); request.onsuccess = () => resolve(request.result); request.onerror = reject; });
    try { return await new Promise<Message[]>((resolve, reject) => { const request = db.transaction("messages").objectStore("messages").index("conversation").getAll(id); request.onsuccess = () => resolve(request.result as Message[]); request.onerror = reject; }); }
    finally { db.close(); }
  }, {id:conversationId, databaseName:await singleHostCacheName(page)})).map(message => messageSchema.parse(message));
}

test("independently paired desktop and phone share conversations, messages, files and catch-up in both directions", async ({ browser }, info) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cross-device-")), stateDir = path.join(root, "instance");
  await mkdir(stateDir); await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ engine: "codex", locale: "zh" }));
  const hub = await HubServer.start({ stateDir: path.join(root, "hub"), clientDir: path.resolve("dist") });
  const secret = randomBytes(32).toString("base64url");
  await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','同步助手',?)", [hashSecret(secret)]);
  const gateway = await attachGateway({ stateDir, url: hub.instanceUrl.replace("http", "ws") + "/instance", botId: "alpha", secret, engine: "codex", runtime: createCoreServiceRuntime(), bridge: { handleAuthorizedMessage: async (input) => ({ text: `已收到：${input.text.trim()}` }) } });
  const desktopContext = await browser.newContext({ viewport: { width: 1360, height: 900 } });
  const phoneContext = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  let desktop = await desktopContext.newPage(), phone = await phoneContext.newPage();
  try {
    await pair(desktop, hub, "验收电脑"); await pair(phone, hub, "验收手机");
    const devices = (await hub.store.devices("owner")).filter(device => device.id !== "pairing_fixture_owner"); expect(devices).toHaveLength(2); expect(new Set(devices.map((d) => d.id)).size).toBe(2);
    await clickAppAction(desktop, "新建群组", desktop.getByRole("button", { name: "新建群组", exact: true }));
    await desktop.getByRole("dialog").getByRole("checkbox").check(); await desktop.getByPlaceholder("为这段对话起个名字").fill("双端工作群");
    await desktop.getByRole("button", { name: "创建群组", exact: true }).click();
    await select(phone, "双端工作群");
    await clickAppAction(phone, "新建话题", phone.getByRole("button", { name: "新建话题", exact: true })); await phone.getByPlaceholder("为这段对话起个名字").fill("手机发起的话题");
    await phone.getByRole("button", { name: "创建话题", exact: true }).click(); await select(desktop, "手机发起的话题");
    await send(desktop, "电脑发送的消息", "同步助手"); await expect(phone.locator(".message-blocks").getByText("电脑发送的消息", { exact: true })).toBeVisible();
    await expect(phone.locator(".message-body").getByText("已收到：电脑发送的消息", { exact: true })).toBeVisible();
    await send(phone, "手机接着回复", "同步助手"); await expect(desktop.locator(".message-blocks").getByText("手机接着回复", { exact: true })).toBeVisible();
    await expect(desktop.locator(".message-body").getByText("已收到：手机接着回复", { exact: true })).toBeVisible();
    for (const [sender, receiver, name, content] of [[desktop, phone, "电脑附件.txt", "电脑里的完整文件\n第一行"], [phone, desktop, "手机附件.txt", "手机里的完整文件\n第二行"]] as const) {
      await sender.locator('input[type="file"][multiple]').setInputFiles({ name, mimeType: "text/plain", buffer: Buffer.from(content) });
      await send(sender, `分享${name}`, "同步助手");
      const attachment = receiver.getByRole("region", { name, exact: true }); await expect(attachment).toBeVisible();
      await attachment.getByRole("button", { name: /^预览(?: |$)/ }).click();
      await expect(receiver.getByRole("dialog", { name: "文件预览" }).locator("pre")).toHaveText(content); await receiver.keyboard.press("Escape");
      const download = receiver.waitForEvent("download"); await attachment.getByRole("button", { name: `另存为 ${name}`, exact: true }).click();
      expect(await readFile((await (await download).path())!, "utf8")).toBe(content);
      await expect(receiver.locator(".message-body").getByText(new RegExp(`已收到：[\\s\\S]*分享${name}`))).toBeVisible();
    }
    const topic = (await hub.store.conversations("owner")).find((c) => c.parentId)!;
    await expect.poll(async () => (await cachedMessages(phone, topic.id)).filter((m) => m.authorType === "bot" && m.status === "complete").length).toBe(4);
    await phone.close(); await send(desktop, "手机关闭期间的消息", "同步助手"); await expect(desktop.locator(".message-body").getByText("已收到：手机关闭期间的消息", { exact: true })).toBeVisible();
    phone = await phoneContext.newPage(); await phone.goto(hub.url); await select(phone, "手机发起的话题", "双端工作群");
    await expect(phone.locator(".message-body").getByText("已收到：手机关闭期间的消息", { exact: true })).toBeVisible();
    await desktop.close(); await send(phone, "电脑关闭期间的消息", "同步助手"); await expect(phone.locator(".message-body").getByText("已收到：电脑关闭期间的消息", { exact: true })).toBeVisible();
    desktop = await desktopContext.newPage(); await desktop.goto(hub.url); await select(desktop, "手机发起的话题");
    await expect(desktop.locator(".message-body").getByText("已收到：电脑关闭期间的消息", { exact: true })).toBeVisible();
    const canonical = (await hub.store.snapshot("owner", topic.id)).messages.sort((a, b) => a.id.localeCompare(b.id));
    expect(canonical.filter((m) => m.authorType === "user")).toHaveLength(6);
    for (const page of [desktop, phone]) await expect.poll(async () => (await cachedMessages(page, topic.id)).sort((a, b) => a.id.localeCompare(b.id))).toEqual(canonical);
    // Reading older messages must not be interrupted by a live update.
    await desktop.locator(".message-scroll").hover(); await desktop.mouse.wheel(0, -10000);
    await expect(desktop.getByRole("button", { name: "回到最新消息", exact: true })).toBeVisible();
    await hub.store.publishBotMessage("alpha", { conversationId: topic.id, blocks: [{ type: "text", text: "查看历史时到达的新结果" }] });
    await expect.poll(async () => (await cachedMessages(desktop, topic.id)).length).toBe(canonical.length + 1);
    expect(await desktop.locator(".message-scroll").evaluate((node) => node.scrollTop)).toBeLessThan(100);
    await desktop.getByRole("button", { name: "回到最新消息", exact: true }).click();
    await expect(desktop.locator(".message-body").getByText("查看历史时到达的新结果", { exact: true })).toBeInViewport();
    // A remote rename must refresh an already-open panel too, without a reload.
    await clickAppAction(desktop, "对话设置", desktop.getByRole("button", { name: "对话设置", exact: true })); await mobileChatAction(phone, "对话设置");
    await phone.getByLabel("对话名称", { exact: true }).fill("两端共用的工作话题"); await phone.getByRole("button", { name: "保存名称", exact: true }).click();
    await expect(desktop.getByLabel("对话名称", { exact: true })).toHaveValue("两端共用的工作话题");
    await desktop.getByLabel("对话名称", { exact: true }).fill("尚未保存的本地编辑");
    await phone.getByLabel("对话名称", { exact: true }).fill("手机更新的话题名"); await phone.getByRole("button", { name: "保存名称", exact: true }).click();
    await expect(desktop.getByRole("heading", { name: "手机更新的话题名", exact: true })).toBeVisible();
    await expect(desktop.getByLabel("对话名称", { exact: true })).toHaveValue("尚未保存的本地编辑");
    await phone.getByLabel("对话名称", { exact: true }).fill("两端共用的工作话题"); await phone.getByRole("button", { name: "保存名称", exact: true }).click();
    for (const page of [desktop, phone]) { await page.getByRole("button", { name: "关闭对话设置", exact: true }).click(); await expect(page.getByRole("heading", { name: "两端共用的工作话题", exact: true, level: 1 })).toBeVisible(); }
    await expect(desktop.getByRole("button", { name: "回到最新消息", exact: true })).toHaveCount(0);
    await expect(desktop.locator(".message-body").getByText("查看历史时到达的新结果", { exact: true })).toBeInViewport();
    await desktop.screenshot({ path: info.outputPath("synced-desktop.png"), fullPage: true }); await phone.screenshot({ path: info.outputPath("synced-phone.png"), fullPage: true });
    await info.attach("cross-device-evidence", { body: JSON.stringify({ independentDevices: devices.length, conversations: 2, messages: canonical.length, fileDirections: 2, closedClientRecoveryDirections: 2 }), contentType: "application/json" });
  } catch (error) {
    const topic = (await hub.store.conversations("owner")).find((c) => c.parentId);
    if (!phone.isClosed() && topic) {
      await info.attach("phone-state", { body: JSON.stringify({ text: await phone.locator("body").innerText(), messages: await cachedMessages(phone, topic.id), canonical: (await hub.store.snapshot("owner", topic.id)).messages }), contentType: "application/json" });
      await phone.screenshot({ path: info.outputPath("phone-failure.png"), fullPage: true });
    }
    throw error;
  } finally { await desktopContext.close(); await phoneContext.close(); await gateway.disconnect(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});

test("phone resolves a desktop request once and both clients share streaming and read state", async ({ browser }) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cross-device-actions-")), stateDir = path.join(root, "instance");
  await mkdir(stateDir); await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ engine: "claude", locale: "zh" }));
  const hub = await HubServer.start({ stateDir: path.join(root, "hub"), clientDir: path.resolve("dist") }); const secret = randomBytes(32).toString("base64url");
  await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','审批助手',?)", [hashSecret(secret)]);
  const decisions: unknown[] = [];
  const gateway = await attachGateway({ stateDir, url: hub.instanceUrl.replace("http", "ws") + "/instance", botId: "alpha", secret, engine: "claude", runtime: createCoreServiceRuntime(), bridge: { handleAuthorizedMessage: async (input) => {
    decisions.push(await input.onApprovalRequest?.({ engine: "claude", toolName: "AskUserQuestion", toolInput: { questions: [{ question: "选哪个方案？", header: "方案", options: [{ label: "快速" }, { label: "完整" }] }] } }));
    return { text: "手机确认后继续完成" };
  } } });
  const conversation = await hub.store.createConversation("owner", ["alpha"], "需要确认的任务", "approval");
  await hub.store.createConversation("owner", ["alpha"], "其他会话", "other");
  const desktopContext = await browser.newContext({ viewport: { width: 1360, height: 900 } }); const phoneContext = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const desktop = await desktopContext.newPage(), phone = await phoneContext.newPage();
  try {
    await pair(desktop, hub, "审批电脑"); await pair(phone, hub, "审批手机"); await select(desktop, conversation.title); await select(phone, conversation.title);
    await send(desktop, "发起确认"); await expect(desktop.getByRole("radio", { name: "完整", exact: true })).toBeVisible(); await phone.getByRole("radio", { name: "完整", exact: true }).check();
    await phone.getByRole("button", { name: "提交", exact: true }).click();
    for (const page of [desktop, phone]) { await expect(page.locator(".message-body").getByText("手机确认后继续完成", { exact: true })).toBeVisible(); await expect(page.getByRole("button", { name: "提交", exact: true })).toHaveCount(0); }
    expect(decisions).toHaveLength(1); expect(decisions[0]).toMatchObject({ behavior: "allow", updatedInput: { answers: { "选哪个方案？": "完整" } } });
    const initial = await hub.store.publishBotMessage("alpha", { conversationId: conversation.id, status: "streaming", blocks: [{ type: "text", text: "正在共同查看" }] });
    for (const page of [desktop, phone]) await expect(page.locator(".message-body").getByText("正在共同查看", { exact: true })).toBeVisible();
    await hub.store.publishBotMessage("alpha", { id: initial.id, conversationId: conversation.id, status: "streaming", blocks: [{ type: "text", text: "正在共同查看，继续生成" }] });
    for (const page of [desktop, phone]) await expect(page.locator(".message-body").getByText("正在共同查看，继续生成", { exact: true })).toBeVisible();
    await hub.store.publishBotMessage("alpha", { id: initial.id, conversationId: conversation.id, status: "complete", blocks: [{ type: "text", text: "两端的最终结果相同" }] });
    for (const page of [desktop, phone]) await expect(page.locator(".message-body").getByText("两端的最终结果相同", { exact: true })).toBeVisible();
    // The app marks read after a focused view has remained open for 250 ms.
    // Rendering alone does not imply that the shared read receipt has arrived.
    const row = (page: Page) => (isPhone(page) ? mobileHome(page).locator(".mh-row") : page.locator(".conversation-row")).filter({ has: page.getByText(conversation.title, { exact: true }) });
    const badge = (page: Page) => row(page).locator(isPhone(page) ? ".mh-badge > [aria-hidden=true]" : ".unread-badge");
    await phone.bringToFront(); await phone.getByRole("textbox", { name: "消息", exact: true }).focus();
    for (const page of [desktop, phone]) await expect(badge(page)).toHaveCount(0);
    for (const page of [desktop, phone]) await select(page, "其他会话");
    await hub.store.publishBotMessage("alpha", { conversationId: conversation.id, blocks: [{ type: "text", text: "等待阅读的后台结果" }] });
    await openMobileHome(phone);
    for (const page of [desktop, phone]) { await expect(row(page)).toBeVisible(); await expect(badge(page)).toHaveText("1"); }
    await phone.bringToFront(); await select(phone, conversation.title); await phone.getByRole("textbox", { name: "消息", exact: true }).focus();
    await expect(desktop.getByRole("heading", { name: "其他会话", exact: true })).toBeVisible();
    await expect(badge(desktop)).toHaveCount(0);
  } finally { await desktopContext.close(); await phoneContext.close(); await gateway.disconnect(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});
