import { preparePairing } from "./fixtures/pairing-invite.js";
import { test, expect, type Page } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HubServer } from "../../src/hub/server.js";
import type { RunSummary } from "../../src/client-protocol/run.js";
import { showDisconnectedBots, selectConversation, waitForClientOnline } from "./fixtures/mobile.js";

async function pair(page: Page, hub: HubServer, title: string) {
  await page.goto(hub.url); await preparePairing(page, hub); await page.getByRole("button", { name: "配对此设备", exact: true }).click();
  await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
  await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" }); await showDisconnectedBots(page);
  await waitForClientOnline(page); await selectConversation(page, title);
}
const run = (id: string, phase: RunSummary["phase"], revision = 1): RunSummary => ({ id, phase, revision, version: 1, startedAt: Date.now() - 1000, updatedAt: Date.now(), count: 0, completed: 0, failed: 0, truncated: false });

for (const width of [390, 1360]) test(`header activity keeps an older running reply after newer messages (${width})`, async ({ page }, info) => {
  await page.setViewportSize({ width, height: 900 });
  const root = await mkdtemp(path.join(os.tmpdir(), "header-reply-"));
  let hub = await HubServer.start({ stateDir: root, clientDir: path.resolve("dist") });
  try {
    await hub.profile.update({ name: "示例主机", revision: (await hub.profile.read()).revision });
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash,online) VALUES('alpha','设计助手','fixture',1)");
    const chat = await hub.store.createConversation("owner", ["alpha"], "持续执行", "running");
    const idle = await hub.store.createConversation("owner", ["alpha"], "另一对话", "idle");
    const publish = (phase: RunSummary["phase"], revision = 1) => hub.store.publishBotMessage("alpha", { id: "long-reply", conversationId: chat.id, status: phase === "done" ? "complete" : "streaming", blocks: [{ type: "card", elements: [{ type: "markdown", text: "正在检查演示内容。" }], extra: { nativeRun: run("long-run", phase, revision) } }] });
    await publish("working");
    await pair(page, hub, chat.title);
    const header = page.locator(".host-workspace:not([hidden]) .conversation-header .header-activity");
    await expect(header).toHaveText("正在回复");
    await expect(page.locator('[data-message-id="long-reply"] .native-run-status')).toContainText("正在执行");
    // Side deliveries and follow-ups must not push the active reply out of the
    // header's view. It is still running even when no token is arriving.
    for (let i = 0; i < 12; i++) await hub.store.publishBotMessage("alpha", { conversationId: chat.id, status: "complete", blocks: [{ type: "text", text: `补充资料 ${i}` }] });
    await expect(page.locator(".message.bot").last()).toContainText("补充资料 11");
    await expect(header).toHaveText("正在回复");
    if (width === 390) await expect(page.getByRole("button", { name: "停止当前轮次", exact: true })).toBeVisible();
    await page.locator(".message-scroll").hover(); await page.mouse.wheel(0, -8000);
    await expect(page.locator('[data-message-id="long-reply"] .native-run-status')).toContainText("正在执行");
    await expect(header.locator("span")).toBeVisible();
    await page.screenshot({ path: info.outputPath(`header-running-${width}.png`) });
    await selectConversation(page, idle.title); await expect(header).toBeEmpty();
    await selectConversation(page, chat.title); await expect(header).toHaveText("正在回复");
    await page.reload(); await waitForClientOnline(page); await selectConversation(page, chat.title);
    await expect(header).toHaveText("正在回复");
    const port = Number(new URL(hub.url).port);
    await hub.close(); await expect(header).toBeEmpty();
    hub = await HubServer.start({ stateDir: root, port, clientDir: path.resolve("dist") });
    await waitForClientOnline(page); await expect(header).toHaveText("正在回复");
    // This fixture has no Gateway reconnecting after the Hub restart. Once the
    // run settles, the existing Bot-offline hint replaces reply activity.
    await publish("done", 2); await expect(header).toHaveText("Bot 离线");
    if (width === 390) await expect(page.getByRole("button", { name: "停止当前轮次", exact: true })).toHaveCount(0);
  } finally { await page.close(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});

test("header activity counts each working Bot once and clears only its settled replies", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 900 });
  const root = await mkdtemp(path.join(os.tmpdir(), "header-reply-group-"));
  const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve("dist") });
  try {
    await hub.profile.update({ name: "示例主机", revision: (await hub.profile.read()).revision });
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash,online) VALUES('alpha','设计助手','fixture-a',1),('beta','研究助手','fixture-b',1),('gamma','写作助手','fixture-c',1)");
    const chat = await hub.store.createConversation("owner", ["alpha", "beta", "gamma"], "协作进度", "group", { type: "group" });
    const publish = (author: string, id: string, status: "streaming" | "complete" | "error" | "pending") => hub.store.publishBotMessage(author, { id, conversationId: chat.id, status, blocks: [{ type: "text", text: `${id} ${status}` }] });
    await publish("alpha", "first", "streaming"); await publish("alpha", "second", "streaming");
    await publish("beta", "research", "streaming"); await publish("gamma", "queued", "pending");
    for (let i = 0; i < 12; i++) await publish("alpha", `delivery-${i}`, "complete");
    await pair(page, hub, chat.title);
    const header = page.locator(".host-workspace:not([hidden]) .conversation-header .header-activity");
    await expect(header).toHaveText("2 个 Bot 正在回复");
    await publish("alpha", "second", "complete"); await expect(header).toHaveText("2 个 Bot 正在回复");
    await publish("alpha", "first", "error"); await expect(header).toHaveText("正在回复 · 研究助手");
    await hub.store.deleteMessages("owner", chat.id, { messageIds: ["research"] }); await expect(header).toBeEmpty();
    // A queued reply is not evidence of execution, but its existing Stop action
    // remains available until the queue itself settles.
    await expect(page.getByRole("button", { name: "停止当前轮次", exact: true })).toBeVisible();
    await publish("gamma", "queued", "complete");
    await expect(page.getByRole("button", { name: "停止当前轮次", exact: true })).toHaveCount(0);
    await expect(header).toBeEmpty();
  } finally { await page.close(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});

for (const width of [390, 1360]) test(`reply marks follow exact prompts and stay stable across phases, reload and themes (${width})`, async ({ page }, info) => {
  await page.setViewportSize({ width, height: 900 });
  const root = await mkdtemp(path.join(os.tmpdir(), "reply-status-"));
  const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve("dist") });
  try {
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash,online) VALUES('alpha','GG1','fixture',1)");
    const chat = await hub.store.createConversation("owner", ["alpha"], "逐条回复状态", "chat");
    const prompts = [];
    for (const [i, text] of ["先帮我梳理报告要点", "再检查附件里的数字", "最后整理一份可分享的总结"].entries()) prompts.push((await hub.store.sendMessage("owner", { conversationId: chat.id, clientMsgId: `p${i}`, text, attachments: [] })).message);
    const publish = (phase: RunSummary["phase"], revision = 1) => hub.store.publishBotMessage("alpha", { id: "reply-second", conversationId: chat.id, replyTo: prompts[1].id, blocks: [{ type: "card", elements: [], extra: { nativeRun: run("second", phase, revision) } }] });
    await pair(page, hub, chat.title);
    const rows = prompts.map(prompt => page.locator(`[data-message-id="${prompt.id}"]`));
    await expect(rows[1]).toBeVisible();
    await expect(page.locator(".user-reply-status")).toHaveCount(0);
    const before = await rows[1].boundingBox();
    await publish("working");
    await expect(rows[1].locator("[data-reply-state=replying]")).toHaveText("回复中");
    await expect(rows[0].locator(".user-reply-status")).toHaveCount(0);
    await expect(rows[2].locator(".user-reply-status")).toHaveCount(0);
    expect((await rows[1].boundingBox())!.height).toBeCloseTo(before!.height, 0);
    await publish("waiting_answer", 2);
    await expect(rows[1].locator("[data-reply-state=waiting_answer]")).toHaveText("等你回答");
    await publish("done", 3);
    await expect(rows[1].locator("[data-reply-state=done]")).toHaveText("已回复");
    await hub.store.failDelivery("alpha", prompts[0].id, "failed");
    await expect(rows[0].locator("[data-reply-state=error]")).toHaveText("回复失败");
    // A late background error must not overturn the foreground success.
    await hub.store.publishBotMessage("alpha", { conversationId: chat.id, replyTo: prompts[1].id, status: "error", blocks: [{ type: "card", elements: [], extra: { scopedRun: run("background", "error"), backgroundTask: { version: 1, origin: "bound" } } }] });
    await expect(rows[1].locator("[data-reply-state=done]")).toHaveText("已回复");
    await page.reload(); await waitForClientOnline(page); await selectConversation(page, chat.title);
    const scroll = page.locator(".message-scroll"); await scroll.hover(); await page.mouse.wheel(0, -5000);
    await expect(rows[1].locator("[data-reply-state=done]")).toBeVisible();
    await expect(rows[2].locator(".user-reply-status")).toHaveCount(0);
    for (const palette of ["default", "cli"]) for (const theme of ["light", "dark"]) {
      await page.evaluate(({ palette, theme }) => { document.documentElement.dataset.palette = palette; document.documentElement.dataset.theme = theme; }, { palette, theme });
      const meta = rows[1].locator(".message-meta");
      expect(await meta.evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
      await page.screenshot({ path: info.outputPath(`${width}-${palette}-${theme}.png`) });
    }
  } finally { await page.close(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});

test("narrow group shows observed Bot counts without claiming every recipient replied", async ({ page }, info) => {
  await page.setViewportSize({ width: 320, height: 900 });
  const root = await mkdtemp(path.join(os.tmpdir(), "reply-group-"));
  const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve("dist") });
  try {
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash,online) VALUES('a','GG1','a',1),('b','CC1','b',1),('c','Kimi','c',1)");
    const chat = await hub.store.createConversation("owner", ["a", "b", "c"], "协作回复状态", "group", { type: "group" });
    const prompt = (await hub.store.sendMessage("owner", { conversationId: chat.id, clientMsgId: "group", text: "请分别核对这份方案", attachments: [] })).message;
    for (const [bot, phase] of [["a", "done"], ["b", "working"], ["c", "error"]] as const) await hub.store.publishBotMessage(bot, { conversationId: chat.id, replyTo: prompt.id, blocks: [{ type: "card", elements: [], extra: { nativeRun: run(bot, phase) } }] });
    await pair(page, hub, chat.title);
    const row = page.locator(`[data-message-id="${prompt.id}"]`);
    await expect(row.locator(".user-reply-status")).toHaveText("1 个 Bot · 回复失败+2");
    await row.locator(".reply-status-trigger").click();
    const detail = page.getByRole("dialog", { name: "此消息的回复状态", exact: true });
    await expect(detail.locator("li").filter({ hasText: "GG1" })).toContainText("已回复");
    await expect(detail.locator("li").filter({ hasText: "CC1" })).toContainText("回复中");
    await expect(detail.locator("li").filter({ hasText: "Kimi" })).toContainText("回复失败");
    await page.getByRole("button", { name: "关闭回复状态", exact: true }).click();
    await expect(row.locator(".reply-status-trigger")).toBeFocused();
    expect(await row.locator(".message-meta").evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
    await page.screenshot({ path: info.outputPath("group-320.png") });
  } finally { await page.close(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});
