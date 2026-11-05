import { preparePairing } from "./fixtures/pairing-invite.js";
import { clickAppAction, revealReplyBots, dismissReplyBots } from "./fixtures/desktop-actions.js";
import { selectConversation, enterMobileChat, mobileChatAction } from "./fixtures/mobile.js";
import { waitForClientOnline } from "./fixtures/mobile.js";
import { test, expect, type Page } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HubServer } from "../../src/hub/server.js";
import { hashSecret } from "../../src/hub/auth.js";
import { attachGateway } from "../../src/gateway/service.js";
import type { GatewayChannel } from "../../src/gateway/channel.js";
import { createCoreServiceRuntime } from "../../src/core/runtime.js";
import { buildCoreConversationKey } from "../../src/core/message-normalizer.js";
import { blocksText } from "../../src/client-protocol/index.js";

async function pair(page: Page, hub: HubServer) {
  await page.goto(hub.url); await preparePairing(page, hub); await page.getByRole("button", { name: "配对此设备", exact: true }).click();
  await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
  await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" });
  await waitForClientOnline(page);
}
async function select(page: Page, title: string, parentTitle?: string) { await selectConversation(page, title, parentTitle); }

async function send(page: Page, text: string) {
  await revealReplyBots(page);
  await page.getByRole("checkbox", { name: "暂时离线的助手", exact: true }).uncheck();
  await page.getByRole("checkbox", { name: "在线助手", exact: true }).check();
  await dismissReplyBots(page);
  await page.getByRole("textbox", { name: "消息", exact: true }).fill(text);
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
}

for (const senderDevice of ["desktop", "phone"] as const) test(`${senderDevice} sends once when another device stops the Bot between pointer down and up`, async ({ browser }, info) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "client-stop-click-")), stateDir = path.join(root, "instance"); await mkdir(stateDir);
  await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ engine: "codex", locale: "zh" }));
  const hub = await HubServer.start({ stateDir: path.join(root, "hub"), clientDir: path.resolve(process.env.TAROCUB_STOP_CLICK_CLIENT_DIR ?? "dist") });
  const desktopContext = await browser.newContext({ viewport: { width: 1360, height: 900 } });
  const phoneContext = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const desktop = await desktopContext.newPage(), phone = await phoneContext.newPage();
  const sender = senderDevice === "desktop" ? desktop : phone, stopper = sender === desktop ? phone : desktop;
  const calls: string[] = []; let gateway: GatewayChannel | undefined;
  try {
    const secret = randomBytes(32).toString("base64url");
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','发送验收助手',?)", [hashSecret(secret)]);
    const chat = await hub.store.createConversation("owner", ["alpha"], "停止后继续", "direct");
    gateway = await attachGateway({ stateDir, url: hub.instanceUrl.replace("http", "ws") + "/instance", secret, botId: "alpha", engine: "codex", runtime: createCoreServiceRuntime(),
      bridge: { handleAuthorizedMessage: async (input) => {
        const text = input.text.includes("继续下一条") ? "继续下一条" : "开始第一条"; calls.push(text);
        if (text === "继续下一条") return { text: "下一条已收到" };
        await input.onEngineEvent?.({ type: "assistant_text", text: "正在处理第一条", delta: true });
        await new Promise<void>((resolve) => { if (input.abortSignal?.aborted) resolve(); else input.abortSignal?.addEventListener("abort", () => resolve(), { once: true }); });
        throw new Error("Stopped by user");
      } } });
    for (const page of [desktop, phone]) { await pair(page, hub); await enterMobileChat(page, chat.title); }
    const draft = sender.getByRole("textbox", { name: "消息", exact: true }), button = sender.getByRole("button", { name: "发送消息", exact: true });
    await draft.fill("开始第一条"); await button.click();
    await expect(stopper.getByText("正在处理第一条", { exact: true })).toBeVisible();
    await draft.fill("继续下一条"); await expect(button).toHaveAttribute("title", /排队/);
    const before = (await button.boundingBox())!;
    // Hold a real pointer press across the remote status update. A shrinking
    // button previously moved out from under its own center before pointerup.
    await sender.mouse.move(before.x + before.width / 2, before.y + before.height / 2); await sender.mouse.down();
    // Trigger the other device's real UI handler without a second synthetic
    // mouse press cancelling the held pointer in the shared browser process.
    await stopper.getByRole("button", { name: "停止当前轮次", exact: true }).evaluate((element: HTMLButtonElement) => element.click());
    await expect(button).not.toHaveAttribute("title", /排队/); await expect(draft).toHaveValue("继续下一条");
    const after = (await button.boundingBox())!;
    await sender.mouse.up();
    for (const page of [desktop, phone]) await expect(page.locator(".message-body").getByText("下一条已收到", { exact: true })).toBeVisible();
    await expect(draft).toHaveValue(""); expect(calls).toEqual(["开始第一条", "继续下一条"]);
    expect((await hub.store.snapshot("owner", chat.id)).messages.filter((message) => message.authorType === "user" && blocksText(message.blocks) === "继续下一条")).toHaveLength(1);
    expect(after).toEqual(before);
    await sender.screenshot({ path: info.outputPath(`stop-click-${senderDevice}.png`) });
    if (senderDevice === "phone") {
      await sender.setViewportSize({ width: 320, height: 844 });
      const toolbar = sender.locator(".composer-toolbar");
      expect(await toolbar.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
      await expect(button).toBeInViewport();
      await sender.screenshot({ path: info.outputPath("stop-click-phone-narrow.png") });
    }
    await info.attach("stop-click-receipt", { body: JSON.stringify({ senderDevice, before, after, submissions: 1, draftCleared: true }), contentType: "application/json" });
  } finally {
    await desktopContext.close().catch(() => {}); await phoneContext.close().catch(() => {});
    try { await gateway?.disconnect(); } finally { await hub.close(); await rm(root, { recursive: true, force: true }); }
  }
});

test("phone stop reaches an online group Bot within one second, preserves its queue and other topic, and cancels an attachment burst on both devices", async ({ browser }, info) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "client-stop-")), stateDir = path.join(root, "instance"); await mkdir(stateDir);
  await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ engine: "codex", locale: "zh" }));
  const hub = await HubServer.start({ stateDir: path.join(root, "hub"), clientDir: path.resolve("dist") });
  const desktopContext = await browser.newContext({ viewport: { width: 1360, height: 900 } });
  const phoneContext = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const desktop = await desktopContext.newPage(), phone = await phoneContext.newPage();
  const errors: string[] = []; for (const page of [desktop, phone]) page.on("pageerror", (error) => errors.push(error.message));
  const runtime = createCoreServiceRuntime({ queuePolicy: { batchWindowMs: 3000 } });
  const calls: string[] = [], aborted = new Map<string, number>(); let gateway: GatewayChannel | undefined;
  try {
    const secret = randomBytes(32).toString("base64url");
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','暂时离线的助手','fixture')");
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('beta','在线助手',?)", [hashSecret(secret)]);
    const group = await hub.store.createConversation("owner", ["alpha", "beta"], "停止操作验收", "group");
    const topic = await hub.store.createConversation("owner", [], "独立话题", "topic", { parentId: group.id });
    gateway = await attachGateway({ stateDir, url: hub.instanceUrl.replace("http", "ws") + "/instance", secret, botId: "beta", engine: "codex", runtime, requireMentionInGroup: false,
      bridge: { handleAuthorizedMessage: async (input) => {
        const key = input.text.includes("下一项") ? "queued" : input.text.includes("独立任务") ? "topic" : "group"; calls.push(key);
        if (key === "queued") return { text: "排队的下一项已完成" };
        await input.onEngineEvent?.({ type: "assistant_text", text: key === "topic" ? "独立话题仍在处理" : "停止前已经生成的内容", delta: true });
        await new Promise<void>((resolve) => { const stop = () => { aborted.set(key, performance.now()); resolve(); }; if (input.abortSignal?.aborted) stop(); else input.abortSignal?.addEventListener("abort", stop, { once: true }); });
        throw new Error("Stopped by user");
      } } });
    for (const page of [desktop, phone]) { await pair(page, hub); await select(page, group.title); }
    await send(desktop, "运行当前任务");
    await expect(phone.getByText("停止前已经生成的内容", { exact: true })).toBeVisible();
    await hub.store.sendMessage("owner", { conversationId: topic.id, clientMsgId: "other_topic", text: "运行独立任务", attachments: [], mentions: ["beta"] });
    await expect.poll(() => runtime.activeRuns.has(buildCoreConversationKey(topic.id))).toBe(true);
    await send(desktop, "/q 继续下一项");
    await expect.poll(() => runtime.chatQueue.pendingCount(buildCoreConversationKey(group.id))).toBe(1);
    const phoneDraft = phone.getByRole("textbox", { name: "消息", exact: true });
    await phoneDraft.fill("停止后保留的草稿");
    const start = performance.now();
    await clickAppAction(phone, "停止当前轮次", phone.getByRole("button", { name: "停止当前轮次", exact: true }));
    await expect.poll(() => aborted.has("group"), { timeout: 1000, intervals: [10, 20, 50] }).toBe(true);
    const abortMs = aborted.get("group")! - start; expect(abortMs).toBeLessThan(1000);
    await expect(phoneDraft).toHaveValue("停止后保留的草稿");
    expect(aborted.has("topic")).toBe(false);
    await expect(phone.getByRole("alert")).toContainText("未能确认所有 Bot 已停止，请检查运行状态。");
    for (const page of [desktop, phone]) {
      await expect(page.locator(".message-body").getByText("排队的下一项已完成", { exact: true })).toBeVisible();
      await expect(page.locator(".native-run-status").getByText("已停止", { exact: true }).first()).toBeVisible();
    }
    expect(calls.filter((key) => key === "queued")).toHaveLength(1);
    await phone.getByRole("button", { name: "关闭提示", exact: true }).click(); await expect(phone.getByRole("alert")).toHaveCount(0);
    // A stop in the topic has its own scope and is visible on the other device.
    for (const page of [desktop, phone]) await select(page, topic.title, group.title);
    await expect(desktop.getByText("独立话题仍在处理", { exact: true })).toBeVisible();
    await clickAppAction(desktop, "停止当前轮次", desktop.getByRole("button", { name: "停止当前轮次", exact: true }));
    await expect.poll(() => aborted.has("topic")).toBe(true);
    await expect(phone.locator(".native-run-status").getByText("已停止", { exact: true }).first()).toBeVisible();
    for (const page of [desktop, phone]) await select(page, group.title);
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jI1EAAAAASUVORK5CYII=", "base64");
    await desktop.locator('input[type="file"][multiple]').setInputFiles({ name: "待分析图片.png", mimeType: "image/png", buffer: png });
    await send(desktop, "图片与文字一起发送，随后取消");
    await expect.poll(() => runtime.pendingBatches.has(buildCoreConversationKey(group.id)), { intervals: [10, 20] }).toBe(true);
    // The image batch has not started a model turn yet; idle actions live in More.
    await mobileChatAction(phone, "停止当前轮次");
    for (const [page, device] of [[desktop, "desktop"], [phone, "phone"]] as const) {
      await expect(page.locator(".message-body").getByText("已同时取消 1 条尚未合并成任务的待发送消息。", { exact: false })).toBeVisible();
      await page.screenshot({ path: info.outputPath(`stop-${device}.png`) });
    }
    await new Promise((resolve) => setTimeout(resolve, 3100)); expect(calls).toEqual(["group", "topic", "queued"]);
    expect(runtime.activeRuns.size).toBe(0); expect(runtime.pendingBatches.size).toBe(0);
    for (const page of [desktop, phone]) {
      await page.reload(); await waitForClientOnline(page); await enterMobileChat(page, group.title);
      await expect(page.locator(".message-body").getByText("已同时取消 1 条尚未合并成任务的待发送消息。", { exact: false })).toBeVisible();
    }
    await info.attach("stop-latency", { body: JSON.stringify({ abortMs, transport: "local browser → real Hub → Gateway → controlled engine AbortSignal", otherTopicPreserved: true, queuedTurnCount: 1 }), contentType: "application/json" });
    console.log("Composer stop latency", JSON.stringify({ abortMs })); expect(errors).toEqual([]);
  } finally {
    await desktopContext.close().catch(() => {}); await phoneContext.close().catch(() => {});
    try { await gateway?.disconnect(); } finally { await hub.close(); await rm(root, { recursive: true, force: true }); }
  }
});
