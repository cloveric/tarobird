import { test, expect } from "@playwright/test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { HubServer } from "../../src/hub/server.js";
import { CONVERSATION_HISTORY_CAPABILITY, historyInternalSnapshotSchema } from "../../src/client-protocol/conversation-history.js";
import { createCoreServiceRuntime } from "../../src/core/runtime.js";
import type { GatewayChannel } from "../../src/gateway/channel.js";
import { gatewayConversationHistory } from "../../src/gateway/conversation-history.js";
import { ConversationHistoryController } from "../../src/runtime/conversation-history.js";
import { preparePairing } from "./fixtures/pairing-invite.js";
import { selectConversation, showDisconnectedBots, waitForClientOnline } from "./fixtures/mobile.js";
import { holdMessage } from "./fixtures/message-actions.js";

// Actual built App and durable synthetic Hub. The history endpoint is a fake:
// no Gateway, native CLI or model is started by this test.
test("App desktop, phone and ADHD menus open the fork while preserving source and neighboring drafts", async ({ browser }, info) => {
  test.setTimeout(90_000);
  const root = await mkdtemp(path.resolve("../.history-ui-fixture-"));
  const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve("dist") });
  const context = await browser.newContext({ viewport: { width: 1360, height: 900 }, locale: "zh-CN", serviceWorkers: "block" });
  const page = await context.newPage(), errors: string[] = [], requests: unknown[] = [], destinations: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  try {
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('history_bot','历史测试助手','fixture')");
    const source = await hub.store.createConversation("owner", ["history_bot"], "历史操作源对话", "history_source");
    const other = await hub.store.createConversation("owner", ["history_bot"], "并排的另一个对话", "history_other");
    await hub.store.publishBotMessage("history_bot", { conversationId: other.id, blocks: [{ type: "text", text: "另一个面板保持原状" }] });
    const sent = await hub.store.sendMessage("owner", { conversationId: source.id, clientMsgId: "fixture_input", text: "从这条消息继续研究", attachments: [] });
    await hub.store.publishBotMessage("history_bot", { conversationId: source.id, replyTo: sent.message.id, blocks: [{ type: "text", text: "原对话的可见回复" }] });
    await page.route("**/api/conversations/*/history**", async route => {
      const url = new URL(route.request().url());
      let body: unknown;
      if (url.pathname.endsWith("/history/operations")) {
        const input = route.request().postDataJSON(); requests.push(input);
        const fork = await hub.store.createConversation("owner", ["history_bot"], input.action.title, input.requestId);
        destinations.push(fork.id);
        const origin = { operationId: "fixture_operation", sourceConversationId: source.id, sourceRevision: "fixture_revision", boundary: "whole" };
        await hub.store.db.run("UPDATE conversations SET history_origin_json=? WHERE id=?", [JSON.stringify(origin), fork.id]);
        body = { requestId: input.requestId, operationId: "fixture_operation", state: "applied", sourceRevision: "fixture_revision", destinationConversationId: fork.id };
      } else if (url.pathname.endsWith("/history/anchors")) body = { anchors: [{ id: "fixture_anchor", messageId: sent.message.id, rewind: true, fork: true, forkBoundary: "after-turn" }] };
      else body = { supported: true, revision: "fixture_revision", capabilities: { rewind: true, fork: true, anchoredFork: true } };
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
    });
    await page.goto(hub.url); await preparePairing(page, hub); await page.getByRole("button", { name: "配对此设备", exact: true }).click();
    await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
    await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" }); await showDisconnectedBots(page); await waitForClientOnline(page); await selectConversation(page, source.title);
    const composer = page.getByRole("textbox", { name: "消息", exact: true }); await composer.fill("源对话里未发送的草稿");
    await page.getByRole("button", { name: "更多聊天操作", exact: true }).click();
    await page.getByRole("button", { name: "分叉当前对话", exact: true }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath("history-app-desktop-menu.png") });
    await page.getByRole("button", { name: "分叉当前对话", exact: true }).click();
    await page.getByRole("dialog", { name: "分叉当前对话？", exact: true }).getByRole("button", { name: "创建分叉对话", exact: true }).click();
    await expect(page.getByRole("heading", { name: "历史操作源对话 · 分叉", exact: true })).toBeVisible();
    await expect(composer).toHaveValue(""); await expect(page.getByText("分叉自「历史操作源对话」", { exact: true })).toBeVisible();
    expect(requests).toHaveLength(1); expect((await hub.store.conversations("owner")).find(value => value.id === source.id)).toEqual(source);
    await page.getByRole("button", { name: "查看原对话", exact: true }).click(); await expect(composer).toHaveValue("源对话里未发送的草稿");
    const row = page.locator(`[data-message-id="${sent.message.id}"]`); await row.click({ button: "right" });
    const menu = page.getByRole("menu", { name: "消息操作", exact: true }); await expect(menu.getByRole("menuitem", { name: "从此处分叉", exact: true })).toBeVisible();
    await menu.getByRole("menuitem", { name: "回退到这条消息之前", exact: true }).scrollIntoViewIfNeeded(); await page.screenshot({ path: info.outputPath("history-app-desktop-point-menu.png") }); await page.keyboard.press("Escape");
    await page.setViewportSize({ width: 390, height: 844 });
    await selectConversation(page, source.title); await holdMessage(page, row);
    const sheet = page.getByRole("dialog", { name: "消息操作", exact: true }); await sheet.getByRole("button", { name: "从此处分叉", exact: true }).click();
    const point = page.getByRole("dialog", { name: "从此处分叉？", exact: true }); await expect(point).toContainText("直到本轮回复结束"); await expect(sheet).toHaveCount(0);
    await point.getByRole("button", { name: "取消", exact: true }).scrollIntoViewIfNeeded(); await expect(point.getByRole("button", { name: "取消", exact: true })).toBeEnabled();
    await page.screenshot({ path: info.outputPath("history-app-phone-point.png") }); await point.getByRole("button", { name: "取消", exact: true }).click();
    await expect(composer).toHaveValue("源对话里未发送的草稿"); expect(requests).toHaveLength(1);
    await page.setViewportSize({ width: 1360, height: 900 }); await page.getByRole("button", { name: "打开 ADHD 模式", exact: true }).click();
    for (const title of [source.title, other.title]) await page.getByRole("checkbox", { name: new RegExp(`加入面板：.* · ${title}$`) }).check();
    const sourcePane = page.locator(`.adhd-card[data-pane-conversation="${source.id}"]`), otherPane = page.locator(`.adhd-card[data-pane-conversation="${other.id}"]`);
    await otherPane.getByRole("textbox").fill("另一个面板的草稿");
    await sourcePane.getByRole("button", { name: "更多聊天操作", exact: true }).click();
    await page.getByRole("button", { name: "分叉当前对话", exact: true }).filter({ visible: true }).click();
    await page.getByRole("dialog", { name: "分叉当前对话？", exact: true }).getByRole("button", { name: "创建分叉对话", exact: true }).click();
    await expect.poll(() => destinations.length).toBe(2);
    const forkPane = page.locator(`.adhd-card[data-pane-conversation="${destinations[1]}"]`);
    await expect(forkPane).toBeVisible(); await expect(forkPane).toHaveClass(/is-focused/); await expect(forkPane.getByRole("textbox")).toHaveValue("");
    await expect(sourcePane.getByRole("textbox")).toHaveValue("源对话里未发送的草稿");
    await expect(otherPane.getByRole("textbox")).toHaveValue("另一个面板的草稿"); await expect(otherPane.getByText("另一个面板保持原状", { exact: true })).toBeVisible();
    await page.screenshot({ path: info.outputPath("history-app-adhd-fork.png") });
    expect(requests).toHaveLength(2); expect(requests.map(input => input.action.title)).toEqual(["历史操作源对话 · 分叉", "历史操作源对话 · 分叉 2"]); expect(errors).toEqual([]);
  } finally { await context.close(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});


test("an open fork menu recovers when the queue drains during its snapshot request", async ({ page }) => {
  const root = await mkdtemp(path.resolve("../.history-ui-fixture-"));
  const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve("dist") });
  let finishBinding!: () => void, sendOlderResponse!: () => void;
  const bindingHeld = new Promise<void>(resolve => { finishBinding = resolve; });
  const olderResponseHeld = new Promise<void>(resolve => { sendOlderResponse = resolve; });
  try {
    const botId = "history_bot";
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('history_bot','历史测试助手','fixture')");
    const source = await hub.store.createConversation("owner", [botId], "队列清空测试", "history_source");
    const stateDir = path.join(root, "worker");
    await mkdir(stateDir);
    await writeFile(path.join(stateDir, "config.json"), "{}");
    let pending = false, holdBinding = false, heldBindings = 0, nativeReads = 0, requests = 0;
    let holdNextResponse = false, responseHeld = false;
    const controller = new ConversationHistoryController({
      getLockNamespace: async () => stateDir,
      getHistoryBinding: async () => {
        if (pending && holdBinding) {
          heldBindings++;
          await bindingHeld;
          pending = false;
        }
        return { record: { telegramChatId: 7, codexSessionId: "fixture-session", status: "idle", updatedAt: "2026-01-01T00:00:00.000Z",
          historyGeneration: "generation", historyRevision: "revision" }, shared: false };
      },
      reserveHistory: async () => { throw new Error("unexpected history mutation"); },
      releaseHistory: async () => { throw new Error("unexpected history mutation"); },
      finalizeHistory: async () => { throw new Error("unexpected history mutation"); },
    }, { getHistoryState: async () => {
      nativeReads++;
      return { head: `head-${nativeReads}`, fork: { whole: true, anchored: false } };
    } });
    const channel = {
      transport: { capabilities: [CONVERSATION_HISTORY_CAPABILITY], requestLive: async () => ({ allowed: true }) },
      isConversationProcessing: () => pending,
    } as unknown as GatewayChannel;
    const gateway = gatewayConversationHistory({ getConversationHistory: controller.get.bind(controller) }, channel, createCoreServiceRuntime(), stateDir, botId);
    await page.route(`**/api/conversations/${source.id}/history?*`, async route => {
      requests++;
      const snapshot = await gateway("history.snapshot", { userId: "owner", botId, conversationId: source.id });
      const { bindingGeneration: _generation, sourceSessionId: _session, ...body } = historyInternalSnapshotSchema.parse(snapshot);
      if (holdNextResponse) {
        holdNextResponse = false;
        responseHeld = true;
        await olderResponseHeld;
      }
      await route.fulfill({ json: body });
    });
    await page.goto(hub.url);
    await preparePairing(page, hub);
    await page.getByRole("button", { name: "配对此设备", exact: true }).click();
    await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
    await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" });
    await showDisconnectedBots(page);
    await waitForClientOnline(page);
    await selectConversation(page, source.title);
    const more = page.getByRole("button", { name: "更多聊天操作", exact: true });
    const fork = page.getByRole("button", { name: "分叉当前对话", exact: true });
    await more.click();
    await expect(fork).toBeEnabled();
    await page.keyboard.press("Escape");
    await expect(fork).toHaveCount(0);

    pending = true;
    await more.click();
    await expect(fork).toBeDisabled();
    await page.keyboard.press("Escape");
    await expect(fork).toHaveCount(0);

    holdNextResponse = true;
    await more.click();
    await expect.poll(() => responseHeld).toBe(true);
    await page.keyboard.press("Escape");
    await expect(fork).toHaveCount(0);

    holdBinding = true;
    const readsBeforeDrain = nativeReads, requestsBeforeDrain = requests;
    const response = page.waitForResponse(value => value.url().includes(`/api/conversations/${source.id}/history?`));
    await more.click();
    await expect(more).toHaveAttribute("aria-expanded", "true");
    await expect.poll(() => heldBindings).toBe(1);
    await expect(fork).toBeDisabled();
    expect(nativeReads).toBe(readsBeforeDrain);
    // Drain only on the Host. The App receives no new activity event.
    finishBinding();
    const recovered = await (await response).json();
    expect(recovered).toMatchObject({ supported: true, revision: expect.any(String) });
    expect(recovered).not.toHaveProperty("blocked");
    await expect(fork).toBeEnabled();
    await expect(more).toHaveAttribute("aria-expanded", "true");
    expect(nativeReads).toBe(readsBeforeDrain + 1);
    expect(requests).toBe(requestsBeforeDrain + 1);

    const older = page.waitForResponse(value => value.url().includes(`/api/conversations/${source.id}/history?`));
    sendOlderResponse();
    expect(await (await older).json()).toMatchObject({ supported: true, blocked: "busy" });
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(fork).toBeEnabled();
  } finally {
    finishBinding();
    sendOlderResponse();
    await hub.close();
    await rm(root, { recursive: true, force: true });
  }
});
