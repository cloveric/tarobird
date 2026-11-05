import { workbenchContentTargets } from "./fixtures/workbench-targets.js";
import { test, expect, type Page } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HubServer } from "../../src/hub/server.js";
import { widgetBlock } from "../../src/client-protocol/widget.js";
import type { WorkbenchBroker } from "../../src/hub/workbench.js";
import type { WorkbenchRequest, WorkbenchTarget } from "../../src/client-protocol/workbench.js";
import { preparePairing } from "./fixtures/pairing-invite.js";
import { selectConversation, showDisconnectedBots, waitForClientOnline } from "./fixtures/mobile.js";

test.use({ serviceWorkers: "block" });
async function fixture(page: Page, secondConversation = false) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "workbench-ui-"));
  const hub = await HubServer.start({ stateDir: directory, clientDir: path.resolve("dist") });
  await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','工作台助手','fixture')");
  const conversation = await hub.store.createConversation("owner", ["alpha"], "工作台验收", "workbench_chat");
  const second = secondConversation ? await hub.store.createConversation("owner", ["alpha"], "另一个对话", "other_workbench_chat") : undefined;
  if (second) await hub.store.publishBotMessage("alpha", { conversationId: second.id, status: "complete", blocks: [widgetBlock({ title: "B 的图表", summary: "B 独立的工作台", report: { version: 1, columns: ["项目", "数量"], rows: [["B", 7]], chart: { kind: "bar", category: 0, values: [1] } } })] });
  const messages = [];
  for (let index = 0; index < 4; index++) messages.push(await hub.store.publishBotMessage("alpha", { id: `report_${index}`, conversationId: conversation.id, status: "complete", blocks: [widgetBlock({ title: `趋势图 ${index + 1}`, summary: "工作台验收数据", report: { version: 1, columns: ["月份", "数量"], rows: [["一月", 2], ["二月", 5]], chart: { kind: "bar", category: 0, values: [1] } } })] }));
  await page.goto(hub.url); await preparePairing(page, hub); await page.getByRole("button", { name: "配对此设备", exact: true }).click();
  await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner"); await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" });
  await waitForClientOnline(page); await showDisconnectedBots(page); await selectConversation(page, conversation.title);
  const broker = (hub as unknown as { workbench: WorkbenchBroker }).workbench, actor = { userId: "owner", conversationId: conversation.id, validate: async () => undefined };
  const targets = () => workbenchContentTargets(broker, actor);
  const command = (request: WorkbenchRequest) => broker.request(actor, request);
  return { hub, conversation, messages, targets, command, context: (messageId: string) => broker.contextForMessage("owner", messageId, conversation.id), close: async () => { await page.close(); await hub.close(); await rm(directory, { recursive: true, force: true }); } };
}
const panel = (page: Page) => page.getByRole("complementary", { name: "工作台", exact: true });
async function open(page: Page) { await page.getByRole("button", { name: "工作台", exact: true }).click(); await expect(panel(page)).toBeVisible(); }

for (const phone of [false, true]) test(`workbench open state belongs to each conversation (${phone ? "phone" : "desktop"})`, async ({ page }, info) => {
  if (phone) await page.setViewportSize({ width: 390, height: 844 });
  const f = await fixture(page, true);
  const toggle = page.getByRole("button", { name: "工作台", exact: true });
  const composer = page.locator(".conversation-main textarea").last();
  const select = async (title: string) => {
    // Navigate away without closing the phone's workbench first.
    if (phone) await page.getByRole("button", { name: "打开会话列表", exact: true }).click();
    await selectConversation(page, title);
  };
  try {
    await composer.fill("A 的草稿"); await composer.blur();
    await page.locator(".message-scroll").getByRole("button", { name: "在工作台打开", exact: true }).first().click();
    await expect(panel(page).getByRole("tab", { name: "趋势图 1", exact: true })).toBeVisible();
    if (!phone) await panel(page).getByRole("button", { name: "展开到主区", exact: true }).click();
    await expect.poll(async () => (await f.targets()).length).toBe(1);

    await select("另一个对话");
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(panel(page)).toBeHidden();
    await expect(page.locator(".workbench-loading")).toHaveCount(0);
    await expect(composer).toBeVisible(); await expect(composer).toHaveValue("");
    await expect.poll(async () => (await f.targets()).length).toBe(0);
    await composer.fill("B 的草稿"); await composer.blur();
    await page.screenshot({ path: info.outputPath("b-stays-closed.png") });

    await open(page);
    await expect(panel(page).getByRole("tab")).toHaveCount(0);
    // The phone hides history under the workbench; close it to use B's message entry.
    await toggle.click();
    await page.locator(".message-scroll").getByRole("button", { name: "在工作台打开", exact: true }).click();
    await expect(panel(page).getByRole("tab", { name: "B 的图表", exact: true })).toBeVisible();
    await toggle.click();

    await select(f.conversation.title);
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect(panel(page).getByRole("tab")).toHaveCount(1);
    await expect(panel(page).getByRole("tab", { name: "趋势图 1", exact: true })).toBeVisible();
    if (!phone) await expect(panel(page).getByRole("button", { name: "返回右侧", exact: true })).toBeVisible();
    await expect(composer).toHaveValue("A 的草稿");
    await page.screenshot({ path: info.outputPath("a-restored.png") });

    await select("另一个对话");
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(panel(page)).toBeHidden(); await expect(composer).toHaveValue("B 的草稿");
    await open(page);
    await expect(panel(page).getByRole("tab")).toHaveCount(1);
    await expect(panel(page).getByRole("tab", { name: "B 的图表", exact: true })).toBeVisible();
    await select(f.conversation.title); await toggle.click();
    await select("另一个对话"); await expect(panel(page)).toBeVisible();
    await select(f.conversation.title); await expect(panel(page)).toBeHidden();
  } finally { await f.close(); }
});

test("chart tabs split 1/2/3/4, maximize and dock without losing the main draft", async ({ page }, info) => {
  const f = await fixture(page);
  try {
    const composer = page.locator(".conversation-main textarea").last(); await composer.fill("尚未发送的主对话草稿");
    await open(page);
    await expect(panel(page).locator(".workbench-empty").getByRole("heading", { name: "工作台", exact: true })).toBeVisible();
    await expect(panel(page).locator(".workbench-tabrow").getByRole("heading")).toHaveCount(0);
    await page.screenshot({ path: info.outputPath("workbench-empty-title.png") });
    for (let index = 0; index < 4; index++) {
      await page.locator(".message-scroll").getByRole("button", { name: "在工作台打开", exact: true }).nth(index).click();
      await expect(panel(page).getByRole("tab", { name: `趋势图 ${index + 1}`, exact: true })).toBeVisible();
    }
    const tabs = panel(page).getByRole("tab"); await expect(tabs).toHaveCount(4);
    await expect(panel(page).locator(".workbench-pane-header, .report-header, .workbench-status")).toHaveCount(0);
    const dock = await panel(page).evaluate(node => {
      const bounds = node.getBoundingClientRect(), main = document.querySelector(".conversation-main")!.getBoundingClientRect(), row = node.querySelector(".workbench-tabrow")!.getBoundingClientRect();
      const buttons = [...node.querySelectorAll(".workbench-tab-actions > button")].map(button => button.getBoundingClientRect());
      return { left: bounds.left, right: bounds.right, mainRight: main.right, top: bounds.top, rowTop: row.top, rowBottom: row.bottom, buttonsFit: buttons.every(button => button.top >= row.top && button.bottom <= row.bottom && button.right <= bounds.right) };
    });
    expect(dock.left).toBeCloseTo(dock.mainRight, 0); expect(dock.right).toBeLessThanOrEqual(1360.5); // WebKit can round transformed bounds by a fraction of a pixel.
    expect(dock.rowTop - dock.top).toBeLessThanOrEqual(1); expect(dock.buttonsFit).toBe(true);
    await expect(panel(page).getByText("与主对话一起工作", { exact: true })).toHaveCount(0);
    await expect(panel(page).getByRole("heading", { name: "工作台", exact: true })).toHaveCount(0);
    const aligned = () => panel(page).evaluate(node => {
      const row = node.querySelector(".workbench-tabrow")!.getBoundingClientRect(), header = node.parentElement!.querySelector(":scope > .conversation-main > .conversation-header")!.getBoundingClientRect();
      const actions = node.querySelector(".workbench-tab-actions")!.getBoundingClientRect();
      const strip = node.querySelector(".workbench-tabs")!.getBoundingClientRect(), selected = node.querySelector('[role="tab"][aria-selected="true"]')!.getBoundingClientRect();
      return { top: Math.abs(row.top - header.top), bottom: Math.abs(row.bottom - header.bottom), fits: selected.left >= strip.left - 1 && selected.right <= strip.right + 1 && strip.left >= row.left && strip.right <= actions.left && actions.right <= row.right && Math.abs((selected.top + selected.bottom) / 2 - (actions.top + actions.bottom) / 2) < 1 && node.scrollWidth <= node.clientWidth + 1 };
    });
    await expect.poll(aligned).toEqual({ top: 0, bottom: 0, fits: true });
    await page.setViewportSize({ width: 1000, height: 900 });
    await expect.poll(aligned).toEqual({ top: 0, bottom: 0, fits: true });
    await page.screenshot({ path: info.outputPath("workbench-header-narrow.png") });
    await page.setViewportSize({ width: 1360, height: 900 });
    await expect.poll(aligned).toEqual({ top: 0, bottom: 0, fits: true });
    await page.screenshot({ path: info.outputPath("workbench-compact-right.png") });
    for (let index = 0; index < 3; index++) { await tabs.nth(index).click({ button: "right" }); await page.getByRole("menu", { name: "标签选项", exact: true }).getByRole("button", { name: "加入分屏", exact: true }).click(); await expect(panel(page).locator(".workbench-pane:visible")).toHaveCount(index + 2); await page.screenshot({ path: info.outputPath(`workbench-side-${index + 2}.png`) }); }
    await expect(panel(page).locator(".workbench-panes")).toHaveAttribute("data-count", "4");
    await expect(panel(page).locator(".workbench-pane-header:visible")).toHaveCount(4);
    await expect(panel(page).locator(".report-header")).toHaveCount(0);
    await expect(panel(page).locator(".workbench-pane:visible")).toHaveCount(4);
    await panel(page).getByRole("button", { name: "放大当前区域", exact: true }).first().click();
    await expect(panel(page).locator(".workbench-pane:visible")).toHaveCount(1);
    await panel(page).getByRole("button", { name: "返回分屏", exact: true }).click();
    await expect(panel(page).locator(".workbench-pane:visible")).toHaveCount(4);
    await panel(page).getByRole("button", { name: "展开到主区", exact: true }).click();
    await expect(panel(page).getByRole("button", { name: "返回右侧", exact: true })).toBeVisible();
    await expect(composer).toHaveValue("尚未发送的主对话草稿"); await expect(composer).toBeVisible();
    const geometry = await page.evaluate(() => { const workbench = document.querySelector(".workbench")!.getBoundingClientRect(), composer = document.querySelector(".conversation-main .composer-wrap")!.getBoundingClientRect(); return { workbenchBottom: workbench.bottom, composerTop: composer.top, width: workbench.width }; });
    expect(geometry.workbenchBottom).toBeLessThanOrEqual(geometry.composerTop + 1); expect(geometry.width).toBeGreaterThan(700);
    const chart = panel(page).locator(".workbench-pane:visible .report-chart").first();
    const svg = chart.locator('svg[role="img"]'); await expect(svg).toBeVisible();
    await svg.locator("[data-series] rect").nth(1).click();
    await expect(chart.getByLabel("选择记录查看数值", { exact: true })).toHaveValue("1");
    await expect(chart.locator(".report-selection")).toContainText("5");
    await chart.getByRole("button", { name: "数量", exact: true }).click(); await expect(chart).toContainText("所有数据系列已隐藏");
    await chart.getByRole("button", { name: "显示全部系列", exact: true }).click(); await expect(svg).toBeVisible();
    await page.screenshot({ path: info.outputPath("workbench-four-pane.png") });
    const readBefore = (await f.hub.store.db.get<{ seq: number }>("SELECT seq FROM reads WHERE user_id='owner' AND conversation_id=?", [f.conversation.id]))?.seq ?? 0;
    await f.hub.store.publishBotMessage("alpha", { conversationId: f.conversation.id, blocks: [{ type: "text", text: "展开工作台时的新消息" }] });
    await page.getByText("展开工作台时的新消息", { exact: true }).waitFor({ state: "attached" });
    // Give the existing read-mark debounce a full settling interval. Hidden
    // history must not advance the durable read cursor during this interval.
    await page.waitForTimeout(500);
    expect((await f.hub.store.db.get<{ seq: number }>("SELECT seq FROM reads WHERE user_id='owner' AND conversation_id=?", [f.conversation.id]))?.seq ?? 0).toBe(readBefore);
    await panel(page).getByRole("button", { name: "返回右侧", exact: true }).click();
    await expect(panel(page).locator(".workbench-pane:visible")).toHaveCount(4); await expect(composer).toHaveValue("尚未发送的主对话草稿");
  } finally { await f.close(); }
});

test("real Host commands edit and undo one saved board, freeze the target, and reject closed targets", async ({ page }, info) => {
  const f = await fixture(page);
  try {
    await open(page); await expect.poll(async () => (await f.targets()).length).toBe(1);
    const create = await f.command({ requestId: "create-board", operation: "whiteboard.create", payload: { title: "流程白板" } });
    expect(create).toMatchObject({ status: "applied", saved: true }); const baseRevision = create.revision!;
    const tabId = (create.result as { tabId: string }).tabId, target: WorkbenchTarget = { ...create.target, tabId };
    await expect(panel(page).getByRole("tab", { name: "流程白板", exact: true })).toBeVisible();
    const request: WorkbenchRequest = { requestId: "draw-one", operation: "whiteboard.patch", target, expectedRevision: baseRevision, payload: { ops: [{ op: "add", id: "first", type: "rectangle", x: 40, y: 60, width: 180, height: 90 }, { op: "add", id: "label", type: "text", x: 70, y: 90, text: "开始" }] } };
    const applied = await f.command(request); expect(applied, JSON.stringify(applied)).toMatchObject({ status: "applied", saved: true, revision: baseRevision + 1 });
    expect(await f.command(request)).toMatchObject({ status: "applied", saved: true, revision: baseRevision + 1 });
    const read = await f.command({ requestId: "read-one", operation: "whiteboard.read", target });
    expect(read.status).toBe("success"); expect((read.result as { scene: { elements: unknown[] } }).scene.elements).toHaveLength(2);
    expect(await f.command({ requestId: "stale", operation: "whiteboard.patch", target, expectedRevision: baseRevision, payload: { ops: [{ op: "delete", id: "first" }] } })).toMatchObject({ status: "conflict" });
    expect(await f.command({ requestId: "undo", operation: "whiteboard.undo", target, expectedRevision: baseRevision + 1 })).toMatchObject({ status: "applied", revision: baseRevision + 2 });
    expect(await f.command({ requestId: "redo", operation: "whiteboard.redo", target, expectedRevision: baseRevision + 2 })).toMatchObject({ status: "applied", revision: baseRevision + 3 });
    await page.screenshot({ path: info.outputPath("workbench-whiteboard.png") });
    await panel(page).locator('[role="tab"][aria-selected="true"]').click({ button: "right" }); await page.getByRole("menu", { name: "标签选项", exact: true }).getByRole("button", { name: "关闭标签", exact: true }).click();
    await expect(panel(page).getByRole("tab", { name: "流程白板", exact: true })).toHaveCount(0);
    await expect.poll(async () => (await f.targets())[0]?.tabs.some(tab => tab.id === tabId)).toBe(false);
    await expect(f.command({ requestId: "closed", operation: "whiteboard.read", target })).rejects.toThrow("workbench_target_closed");
    await panel(page).getByRole("button", { name: "全部标签和已关闭内容", exact: true }).click(); await panel(page).getByRole("menu").getByRole("button", { name: "流程白板", exact: true }).click();
    await expect.poll(async () => (await f.targets())[0]?.tabs.find(tab => tab.id === tabId)?.revision).toBe(baseRevision + 3);
    const reopened = await f.command({ requestId: "reopened", operation: "whiteboard.read", target }); expect((reopened.result as { scene: { elements: unknown[] } }).scene.elements).toHaveLength(2);
    const importContent = { type: "excalidraw", version: 2, source: "test", elements: (reopened.result as { scene: { elements: unknown[] } }).scene.elements, appState: {}, files: {} };
    await panel(page).locator('.workbench-pane:visible input[type="file"]').setInputFiles({ name: "导入的新白板.excalidraw", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(importContent)) });
    await expect(panel(page).getByRole("tab", { name: "导入的新白板", exact: true })).toBeVisible();
    const original = await f.command({ requestId: "original-after-import", operation: "whiteboard.read", target });
    expect(original.revision).toBe(baseRevision + 3); expect((original.result as { scene: { elements: unknown[] } }).scene.elements).toHaveLength(2);
    await panel(page).getByRole("tab", { name: "流程白板", exact: true }).click();
    await page.locator(".conversation-main textarea").last().fill("在当前白板继续画审核步骤");
    await page.getByRole("button", { name: "发送消息", exact: true }).click();
    await panel(page).getByRole("button", { name: "新建内容", exact: true }).click(); await panel(page).getByRole("button", { name: "新建白板", exact: true }).click();
    await expect.poll(async () => (await f.hub.store.db.get<{ id: string }>("SELECT id FROM messages WHERE conversation_id=? AND author_type='user' ORDER BY created_at DESC LIMIT 1", [f.conversation.id]))?.id).toBeTruthy();
    const sent = await f.hub.store.db.get<{ id: string }>("SELECT id FROM messages WHERE conversation_id=? AND author_type='user' ORDER BY created_at DESC LIMIT 1", [f.conversation.id]);
    expect(await f.context(sent!.id)).toMatchObject({ target: { tabId }, revision: baseRevision + 3 });
  } finally { await f.close(); }
});

test("chart updates retain the tab and refuse invalid or deleted source data", async ({ page }) => {
  const f = await fixture(page);
  try {
    await open(page); await expect.poll(async () => (await f.targets()).length).toBe(1);
    const source = { messageId: f.messages[0].id, blockIndex: 0, version: f.messages[0].version };
    const opened = await f.command({ requestId: "open-chart", operation: "chart.open", payload: { source } }); expect(opened.status).toBe("applied");
    const tabId = (opened.result as { tabId: string }).tabId, target = { ...opened.target, tabId };
    const updatedSource = { messageId: f.messages[1].id, blockIndex: 0, version: f.messages[1].version };
    expect(await f.command({ requestId: "change-chart", operation: "chart.update", target, payload: { previousSource: source, source: updatedSource } })).toMatchObject({ status: "applied", saved: true, result: { tabId } });
    await expect(panel(page).locator(".inline-report")).toHaveAttribute("aria-label", "趋势图 2"); await expect(panel(page).getByRole("tab")).toHaveCount(1);
    expect(await f.command({ requestId: "wrong-source", operation: "chart.update", target, payload: { previousSource: updatedSource, source: { messageId: "missing", blockIndex: 0, version: 0 } } })).toMatchObject({ status: "not_executed" });
    await expect(panel(page).locator(".inline-report")).toHaveAttribute("aria-label", "趋势图 2");
    const failed = await f.hub.store.publishBotMessage("alpha", { conversationId: f.conversation.id, status: "complete", blocks: [widgetBlock({ title: "失败候选", summary: "验证错误回滚", html: "<main><h3>失败候选</h3><script>throw new Error('workbench-fixture-failure')</script></main>" })] });
    await page.locator(".message-scroll").getByText("失败候选", { exact: true }).first().waitFor();
    const rejected = await f.command({ requestId: "failed-render", operation: "chart.update", target, payload: { previousSource: updatedSource, source: { messageId: failed.id, blockIndex: 0, version: failed.version } } });
    expect(rejected.status).toBe("not_executed"); await expect(panel(page).locator(".inline-report")).toHaveAttribute("aria-label", "趋势图 2");
    await f.hub.store.deleteMessages("owner", f.conversation.id, { messageIds: [updatedSource.messageId] });
    await expect(panel(page)).toContainText("来源已更新、删除或不可访问"); await expect(panel(page).locator(".inline-report")).toHaveCount(0);
    await panel(page).locator('[role="tab"][aria-selected="true"]').click({ button: "right" }); await page.getByRole("menu", { name: "标签选项", exact: true }).getByRole("button", { name: "关闭标签", exact: true }).click();
    await panel(page).getByRole("button", { name: "全部标签和已关闭内容", exact: true }).click();
    await panel(page).getByRole("button", { name: "移除最近关闭记录：趋势图 1", exact: true }).click();
    await panel(page).getByRole("button", { name: "全部标签和已关闭内容", exact: true }).click();
    await expect(panel(page).getByRole("menu").getByRole("button", { name: "趋势图 1", exact: true })).toHaveCount(0);
  } finally { await f.close(); }
});

test("one local board has only one writable window and reopens after the owner leaves", async ({ page, context }) => {
  const f = await fixture(page); let other: Page | undefined;
  try {
    await open(page); await expect.poll(async () => (await f.targets()).length).toBe(1);
    expect(await f.command({ requestId: "owned-board", operation: "whiteboard.create", payload: { title: "同机白板" } })).toMatchObject({ status: "applied", saved: true });
    await expect(panel(page).locator(".workbench-canvas-status")).toContainText("已保存在本机");
    other = await context.newPage(); await other.goto(f.hub.url); await waitForClientOnline(other); await selectConversation(other, f.conversation.title); await open(other);
    await expect(panel(other).locator(".workbench-canvas-status")).toContainText("另一窗口正在编辑");
    await panel(page).getByRole("button", { name: "返回聊天", exact: true }).click(); await expect(panel(page)).toBeHidden();
    await other.reload(); await waitForClientOnline(other); await selectConversation(other, f.conversation.title); await open(other);
    await expect(panel(other).locator(".workbench-canvas-status")).toContainText("已保存在本机");
  } finally { await other?.close(); await f.close(); }
});

test("phone single-page viewing preserves desktop split layout and the original composer", async ({ page }, info) => {
  const f = await fixture(page);
  try {
    for (let index = 0; index < 2; index++) await page.locator(".message-scroll").getByRole("button", { name: "在工作台打开", exact: true }).nth(index).click();
    await panel(page).getByRole("tab").first().click({ button: "right" }); await page.getByRole("menu", { name: "标签选项", exact: true }).getByRole("button", { name: "加入分屏", exact: true }).click();
    await expect(panel(page).locator(".workbench-panes")).toHaveAttribute("data-count", "2");
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(panel(page).locator(".workbench-pane:visible")).toHaveCount(1); await expect(page.locator(".conversation-main .composer-wrap")).toBeVisible();
    await panel(page).getByRole("tab").last().click();
    for (const width of [320, 390]) {
      await page.setViewportSize({ width, height: 844 });
      const bar = panel(page).locator(".workbench-tabrow"); await expect(bar.getByRole("button", { name: "返回聊天", exact: true })).toBeVisible();
      await expect(panel(page).getByRole("tab").last()).toHaveCSS("font-size", "13px");
      expect(await bar.evaluate(node => { const box = node.getBoundingClientRect(); return [...node.querySelectorAll(".workbench-tab-actions > button")].every(button => { const rect = button.getBoundingClientRect(); return rect.left >= box.left && rect.right <= box.right && rect.top >= box.top && rect.bottom <= box.bottom; }); })).toBe(true);
    }
    await page.screenshot({ path: info.outputPath("workbench-phone.png") });
    await page.setViewportSize({ width: 1360, height: 900 }); await expect(panel(page).locator(".workbench-pane:visible")).toHaveCount(2);
  } finally { await f.close(); }
});

test("phone workbench stays aligned after returning from the conversation list", async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const f = await fixture(page);
  try {
    const composer = page.locator(".conversation-main textarea").last();
    await composer.fill("返回后仍保留的草稿");
    await composer.blur();
    await open(page);
    await panel(page).getByRole("button", { name: "白板", exact: true }).click();
    const board = panel(page).locator(".workbench-canvas");
    await expect(board).toHaveAttribute("data-board-saved", "true");
    const id = await board.getAttribute("data-board-id");
    for (let visit = 0; visit < 2; visit++) {
      // Keep the workbench open while navigating away, like the phone header
      // Back button. selectConversation must restore that same workbench.
      await page.getByRole("button", { name: "打开会话列表", exact: true }).click();
      await expect(panel(page)).toBeHidden();
      await selectConversation(page, f.conversation.title);
      await expect(panel(page)).toBeVisible();
      await page.locator(".conversation-main").evaluate(async element => {
        await Promise.all(element.getAnimations().map(animation => animation.finished.catch(() => {})));
      });
      const geometry = () => panel(page).evaluate(element => {
        const box = element.getBoundingClientRect();
        const history = element.parentElement!.querySelector(".conversation-main > .message-scroll")!.getBoundingClientRect();
        return { left: Math.round(box.left - history.left), right: Math.round(box.right - history.right), top: Math.round(box.top - history.top), bottom: Math.round(box.bottom - history.bottom) };
      });
      await page.screenshot({ path: info.outputPath(`phone-return-${visit}.png`) });
      await expect.poll(geometry).toEqual({ left: 0, right: 0, top: 0, bottom: 0 });
      await expect(board).toHaveAttribute("data-board-id", id!);
      await expect(composer).toHaveValue("返回后仍保留的草稿");
    }
  } finally { await f.close(); }
});

test("embedded widgets keep authored content and retry without duplicate title or expand controls", async ({ page }, info) => {
  const f = await fixture(page);
  try {
    await page.evaluate(() => {
      const diagnostics: unknown[] = []; Object.assign(window,{workbenchWidgetDiagnostics:diagnostics});
      window.addEventListener("message", event => { if (event.data?.type === "tarobot-widget-error") diagnostics.push(event.data); });
    });
    await open(page); await expect.poll(async () => (await f.targets()).length).toBe(1);
    const source = await f.hub.store.publishBotMessage("alpha", { conversationId: f.conversation.id, status: "complete", blocks: [widgetBlock({
      title: "交互示例", summary: "错误后仍可查看的摘要。",
      html: '<main><h2>页面自己的标题</h2><p>这是内容，不是工作台重复的标题栏。</p><button onclick="setInterval(()=>{throw new Error(\'WORKBENCH_RETRY_FIXTURE\')},50)">触发错误</button></main>',
    })] });
    expect(await f.command({ requestId: "open-widget-chrome", operation: "chart.open", payload: { source: { messageId: source.id, blockIndex: 0, version: source.version } } })).toMatchObject({ status: "applied", saved: true });
    const wb = panel(page), guest = wb.frameLocator('.widget-panel:visible > iframe').frameLocator('iframe');
    await expect(wb.getByRole("tab", { name: "交互示例", exact: true })).toBeVisible();
    await expect(wb.locator(".workbench-pane-header, .widget-header, .workbench-status")).toHaveCount(0);
    await expect(wb.getByRole("button", { name: "放大交互组件", exact: true })).toHaveCount(0);
    await expect(guest.getByRole("heading", { name: "页面自己的标题", exact: true })).toBeVisible();
    await expect(wb.locator(".widget-panel > iframe")).not.toHaveAttribute("aria-busy", "true");
    await page.screenshot({ path: info.outputPath("workbench-widget-single-title.png") });
    await guest.getByRole("button", { name: "触发错误", exact: true }).click();
    await expect(wb.locator(".widget-panel > iframe")).toHaveCount(0);
    const retry = wb.getByRole("button", { name: "重新加载组件", exact: true });
    await expect(retry).toHaveCount(1); await expect(retry).toBeVisible();
    await expect(wb.locator(".widget-summary")).toContainText("错误后仍可查看的摘要。");
    await retry.click();
    await expect(guest.getByRole("heading", { name: "页面自己的标题", exact: true })).toBeVisible();
    await expect(retry).toHaveCount(0);
    await expect(wb.locator(".widget-header")).toHaveCount(0);
  } finally {
    await info.attach("widget-diagnostics.json", {body:JSON.stringify(await page.evaluate(() => (window as any).workbenchWidgetDiagnostics)),contentType:"application/json"});
    await f.close();
  }
});

test("unrelated conversation updates preserve the live widget while deleting its source retires it", async ({page}) => {
  const f = await fixture(page);
  try {
    await open(page); await expect.poll(async () => (await f.targets()).length).toBe(1);
    const source = await f.hub.store.publishBotMessage("alpha", {conversationId:f.conversation.id,status:"complete",blocks:[widgetBlock({title:"保持交互",summary:"测试交互状态",html:'<p id="count">0</p><button onclick="document.getElementById(\'count\').textContent=String(Number(document.getElementById(\'count\').textContent)+1)">增加</button>'})]});
    expect(await f.command({requestId:"stable-widget",operation:"chart.open",payload:{source:{messageId:source.id,blockIndex:0,version:source.version}}})).toMatchObject({status:"applied"});
    const wb = panel(page), frame = wb.locator(".widget-panel > iframe"), guest = wb.frameLocator(".widget-panel > iframe").frameLocator("iframe");
    await guest.getByRole("button",{name:"增加",exact:true}).click(); await expect(guest.locator("#count")).toHaveText("1");
    await frame.evaluate(node => node.setAttribute("data-workbench-lifetime","retained"));
    await f.hub.store.publishBotMessage("alpha", {conversationId:f.conversation.id,status:"complete",blocks:[{type:"text",text:"无关的聊天更新，不改变图表来源"}]});
    await expect(page.locator(".message-scroll")).toContainText("无关的聊天更新，不改变图表来源");
    await expect(frame).toHaveAttribute("data-workbench-lifetime","retained");
    await expect(guest.locator("#count")).toHaveText("1");
    await f.hub.store.deleteMessages("owner", f.conversation.id, {messageIds:[source.id]});
    await expect(wb).toContainText("来源已更新、删除或不可访问"); await expect(frame).toHaveCount(0);
  } finally { await f.close(); }
});
