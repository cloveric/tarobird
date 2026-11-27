import { test, expect, type Page } from "@playwright/test";
import type { ViteDevServer } from "vite";
import { createServer } from "./fixtures/vite.js";

let server: ViteDevServer;
test.beforeAll(async () => { server = await createServer({ server: { port: 0, host: "127.0.0.1" } }); await server.listen(); });
test.afterAll(async () => { await server.close(); });
const fixture = (page: Page, query = "") => page.goto(server.resolvedUrls!.local[0] + "e2e/fixtures/conversation-history.html" + query);
const change = (page: Page, values: Record<string, unknown>) => page.evaluate(values => { Object.assign((window as any).historyFixture, values); (window as any).historyFixture.update(); }, values);
const message = (page: Page, id = "user_b") => page.locator(`[data-message-id="${id}"]`);
const posts = (page: Page) => page.evaluate(() => (window as any).historyFixture.posts);
async function pointMenu(page: Page, id = "user_b") { await message(page, id).click({ button: "right" }); return page.getByRole("menu", { name: "消息操作", exact: true }); }

test("old and unsupported Hosts expose no history actions or speculative writes", async ({ page }) => {
  for (const query of ["?old=1", "?unsupported=1"]) {
    await fixture(page, query); const menu = await pointMenu(page);
    await expect(menu.getByRole("menuitem", { name: "从此处分叉", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "分叉当前对话", exact: true })).toHaveCount(0);
    expect(await posts(page)).toHaveLength(0);
    if (query.includes("old")) expect(await page.evaluate(() => (window as any).historyFixture.calls)).toHaveLength(0);
  }
});

test("whole-session engines have one truthful entry and source-preserving new conversation", async ({ page }) => {
  await fixture(page, "?whole=1"); const source = await page.evaluate(() => structuredClone((window as any).historyFixture.conversations[0]));
  const menu = await pointMenu(page); await expect(menu.getByText("从此处分叉", { exact: true })).toHaveCount(0); await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "分叉当前对话", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "分叉当前对话？", exact: true });
  await expect(dialog).toContainText("原对话保持不变"); await expect(dialog).toContainText("不会复制或回滚文件");
  await dialog.getByRole("button", { name: "创建分叉对话", exact: true }).click();
  await expect(page.getByRole("heading", { name: "研究计划 · 分叉", exact: true })).toBeVisible();
  expect((await posts(page))[0].action).toMatchObject({ kind: "fork", scope: "whole" });
  expect(await page.evaluate(() => (window as any).historyFixture.conversations[0])).toEqual(source);
  await expect(page.getByText("分叉自「研究计划」", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "查看原对话", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "消息", exact: true })).toHaveValue("保留的草稿");
  await page.getByRole("button", { name: "分叉当前对话", exact: true }).click();
  const again = page.getByRole("dialog", { name: "分叉当前对话？", exact: true }); await expect(again.getByRole("button", { name: "取消", exact: true })).toBeEnabled();
  await again.getByRole("button", { name: "取消", exact: true }).click(); expect(await posts(page)).toHaveLength(1);
});

test("only exact native USER anchors rewind; retained rows receive exclusion markers", async ({ page }) => {
  await fixture(page);
  for (const id of ["user_a", "bot_b", "unmapped"]) { const menu = await pointMenu(page, id); await expect(menu.getByRole("menuitem", { name: "回退到这条消息之前", exact: true })).toHaveCount(0); await page.keyboard.press("Escape"); }
  let menu = await pointMenu(page); await menu.getByRole("menuitem", { name: "回退到这条消息之前", exact: true }).click();
  let dialog = page.getByRole("dialog", { name: "回退到这条消息之前？", exact: true });
  await expect(dialog).toContainText("工作区文件不会回滚"); await expect(dialog.getByRole("button", { name: "取消", exact: true })).toBeFocused();
  await page.keyboard.press("Escape"); expect(await posts(page)).toHaveLength(0); await expect(message(page)).toBeFocused();
  menu = await pointMenu(page); await menu.getByRole("menuitem", { name: "回退到这条消息之前", exact: true }).click();
  dialog = page.getByRole("dialog", { name: "回退到这条消息之前？", exact: true }); await dialog.getByRole("button", { name: "确认回退", exact: true }).click();
  await expect(page.getByText("上下文已回退，文件未改动。", { exact: true }).first()).toBeVisible();
  await expect(message(page).getByText("已排除出上下文", { exact: true })).toBeVisible(); await expect(message(page, "bot_b").getByText("已排除出上下文", { exact: true })).toBeVisible();
  await expect(message(page, "bot_b").getByRole("button", { name: "继续原任务", exact: true })).toBeDisabled();
  await expect(message(page, "user_a").getByText("已排除出上下文", { exact: true })).toHaveCount(0); await expect(message(page, "unmapped").getByText("已排除出上下文", { exact: true })).toHaveCount(0);
  expect((await posts(page))[0].action).toEqual({ kind: "rewind", anchorId: "anchor_b" });
  await expect(page.getByRole("textbox", { name: "消息", exact: true })).toHaveValue("保留的草稿");
});

test("point fork states its native boundary and never replays the selected message", async ({ page }) => {
  await fixture(page); const menu = await pointMenu(page); await menu.getByRole("menuitem", { name: "从此处分叉", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "从此处分叉？", exact: true }); await expect(dialog).toContainText("这条消息之前的上下文");
  await dialog.getByRole("button", { name: "创建分叉对话", exact: true }).click();
  await expect(page.getByRole("heading", { name: "研究计划 · 分叉", exact: true })).toBeVisible();
  expect((await posts(page))[0].action).toMatchObject({ kind: "fork", scope: "anchor", anchorId: "anchor_b" });
  expect(await page.evaluate(() => (window as any).historyFixture.calls.some(call => call.route.includes("/messages")))).toBe(false);
});

test("rewind success waits for the committed exclusion cursor", async ({ page }) => {
  await fixture(page); await change(page, { projectedSeq: 0 });
  const menu = await pointMenu(page); await menu.getByRole("menuitem", { name: "回退到这条消息之前", exact: true }).click();
  await page.getByRole("button", { name: "确认回退", exact: true }).click();
  await expect(page.getByText("上下文已回退，正在同步历史。", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("上下文已回退，文件未改动。", { exact: true })).toHaveCount(0); await expect(page.getByRole("button", { name: "发送", exact: true })).toBeDisabled();
  await change(page, { projectedSeq: 10 }); await expect(page.getByText("上下文已回退，文件未改动。", { exact: true }).first()).toBeVisible(); expect(await posts(page)).toHaveLength(1);
});

test("busy, queues, goals and stale revisions block admission with localized reasons", async ({ page }) => {
  await fixture(page);
  for (const [blocked, text] of [
    ["busy", "当前对话正在回复中，请等待结束后再操作。"],
    ["background_work", "后台任务正在运行中，请等待结束后再操作。"],
    ["side_session", "当前有打开的侧边对话，请等待回答结束或关闭后再操作。"],
    ["queued", "请先处理待执行消息。"],
    ["goal_active", "请先暂停当前目标。"],
    ["future_reason_v2", "请刷新会话状态后重试。"],
  ]) {
    await page.evaluate(blocked => { const f = (window as any).historyFixture; f.snapshot.blocked = blocked; f.history.refresh(); }, blocked);
    await expect(page.getByRole("button", { name: "分叉当前对话", exact: true })).toBeDisabled(); await expect(page.getByText(text, { exact: true })).toBeVisible();
  }
  // An older Host answers a running conversation without capabilities or revision: keep the entry, disabled.
  await page.evaluate(() => { const f = (window as any).historyFixture; f.saved = { ...f.snapshot }; f.snapshot = { supported: true, blocked: "busy" }; f.history.refresh(); });
  await expect(page.getByRole("button", { name: "分叉当前对话", exact: true })).toBeDisabled(); await expect(page.getByText("当前对话正在回复中，请等待结束后再操作。", { exact: true })).toBeVisible();
  await page.evaluate(() => { const f = (window as any).historyFixture; f.snapshot = f.saved; delete f.snapshot.blocked; f.history.refresh(); });
  await page.getByRole("button", { name: "分叉当前对话", exact: true }).click();
  await page.evaluate(() => { (window as any).historyFixture.snapshot.revision = "new_revision"; });
  await page.getByRole("button", { name: "创建分叉对话", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("会话已变化"); expect(await posts(page)).toHaveLength(0);
});

test("double confirmation and lost response survive reload with receipt-only recovery", async ({ page }) => {
  await fixture(page); await change(page, { mode: "unknown" });
  await page.getByRole("button", { name: "分叉当前对话", exact: true }).click();
  await page.getByRole("button", { name: "创建分叉对话", exact: true }).evaluate((button: HTMLButtonElement) => { button.click(); button.click(); });
  await expect(page.getByRole("dialog", { name: "核对历史操作", exact: true })).toBeVisible(); expect(await posts(page)).toHaveLength(1);
  await expect(page.getByRole("button", { name: "发送", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "关闭历史操作", exact: true }).click();
  await page.reload(); await expect(page.getByRole("button", { name: "发送", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "核对结果", exact: true }).click();
  await page.getByRole("dialog", { name: "核对历史操作", exact: true }).getByRole("button", { name: "核对结果", exact: true }).click();
  await expect(page.getByRole("heading", { name: "研究计划 · 分叉", exact: true })).toBeVisible(); expect(await posts(page)).toHaveLength(1);
  expect(await page.evaluate(() => (window as any).historyFixture.calls.filter(call => call.route.includes("/operations/")).every(call => call.route.split("?")[0].endsWith("/reconcile") && call.method === "POST"))).toBe(true);
});

test("reload after local admission but before POST safely tombstones the same request", async ({ page }) => {
  await fixture(page); await change(page, { holdPersistence: true });
  await page.getByRole("button", { name: "分叉当前对话", exact: true }).click(); await page.getByRole("button", { name: "创建分叉对话", exact: true }).click();
  await expect.poll(() => page.evaluate(() => Object.keys(localStorage).some(key => key.startsWith("record:conversation-history:")))).toBe(true);
  const request = await page.evaluate(() => JSON.parse(localStorage.getItem(Object.keys(localStorage).find(key => key.startsWith("record:conversation-history:"))!)!).change);
  expect(await posts(page)).toHaveLength(0); await page.reload();
  await expect(page.getByRole("button", { name: "发送", exact: true })).toBeDisabled(); await page.getByRole("button", { name: "核对结果", exact: true }).click();
  await page.getByRole("dialog", { name: "核对历史操作", exact: true }).getByRole("button", { name: "核对结果", exact: true }).click();
  await expect(page.getByRole("alert")).toHaveText("操作已取消。"); await expect(page.getByRole("button", { name: "发送", exact: true })).toBeEnabled();
  const late = await page.evaluate(change => (window as any).historyFixture.connection.changeHistory("source", change), request);
  expect(late).toMatchObject({ state: "rejected", reason: "cancelled", requestId: request.requestId }); expect(await posts(page)).toHaveLength(0);
  await page.getByRole("button", { name: "关闭历史操作", exact: true }).click(); await expect(page.getByRole("button", { name: "分叉当前对话", exact: true })).toBeEnabled();
});

test("late receipt cannot navigate a different conversation; local outbox blocks new history", async ({ page }) => {
  await fixture(page); await change(page, { pendingMessages: true });
  await expect(page.getByRole("button", { name: "分叉当前对话", exact: true })).toBeDisabled();
  await change(page, { pendingMessages: false, mode: "hold" }); await page.getByRole("button", { name: "分叉当前对话", exact: true }).click(); await page.getByRole("button", { name: "创建分叉对话", exact: true }).click();
  await expect.poll(() => posts(page).then(values => values.length)).toBe(1);
  await page.evaluate(() => { const f = (window as any).historyFixture; f.conversations.push({ ...f.conversations[0], id: "other", title: "另一段对话" }); f.selected = "other"; f.update(); f.release(); });
  await expect(page.getByRole("heading", { name: "另一段对话", exact: true })).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0); expect(await posts(page)).toHaveLength(1);
});

test("receipt lookup failure preserves pending identity and never submits a second operation", async ({ page }) => {
  await fixture(page); await change(page, { mode: "unknown", checkFailure: true });
  await page.getByRole("button", { name: "分叉当前对话", exact: true }).click(); await page.getByRole("button", { name: "创建分叉对话", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "核对历史操作", exact: true }); await dialog.getByRole("button", { name: "核对结果", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("尚未确认"); await expect(page.getByRole("button", { name: "分叉当前对话", exact: true })).toBeDisabled();
  expect(await posts(page)).toHaveLength(1); await change(page, { checkFailure: false }); await dialog.getByRole("button", { name: "核对结果", exact: true }).click();
  await expect(page.getByRole("heading", { name: "研究计划 · 分叉", exact: true })).toBeVisible(); expect(await posts(page)).toHaveLength(1);
});

test("Host and authenticated user scopes cannot inherit another scope's pending mutation", async ({ page }) => {
  await fixture(page); await change(page, { mode: "unknown" });
  await page.getByRole("button", { name: "分叉当前对话", exact: true }).click(); await page.getByRole("button", { name: "创建分叉对话", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "核对历史操作", exact: true })).toBeVisible();
  await page.evaluate(() => { const f = (window as any).historyFixture; f.connection.identity = { ...f.connection.identity, hubPublicKey: "other_host" }; f.update(); });
  await expect(page.getByRole("dialog")).toHaveCount(0); await expect(page.getByRole("button", { name: "分叉当前对话", exact: true })).toBeEnabled();
  await page.evaluate(() => { const f = (window as any).historyFixture; f.connection.identity = { ...f.connection.identity, hubPublicKey: "synthetic_host" }; f.connection.state.user = { id: "another_owner", role: "owner" }; f.update(); });
  await expect(page.getByRole("button", { name: "分叉当前对话", exact: true })).toBeEnabled();
  await page.evaluate(() => { const f = (window as any).historyFixture; f.connection.state.user = { id: "owner", role: "owner" }; f.update(); });
  await expect(page.getByRole("button", { name: "分叉当前对话", exact: true })).toBeDisabled(); await expect(page.getByRole("button", { name: "核对结果", exact: true })).toBeVisible(); expect(await posts(page)).toHaveLength(1);
});

test("applied fork with failed directory sync recovers the existing conversation", async ({ page }) => {
  await fixture(page); await change(page, { directoryFailure: true });
  await page.getByRole("button", { name: "分叉当前对话", exact: true }).click(); await page.getByRole("button", { name: "创建分叉对话", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "核对历史操作", exact: true }); await expect(dialog).toBeVisible(); expect(await posts(page)).toHaveLength(1);
  await change(page, { directoryFailure: false }); await dialog.getByRole("button", { name: "核对结果", exact: true }).click();
  await expect(page.getByRole("heading", { name: "研究计划 · 分叉", exact: true })).toBeVisible(); expect(await posts(page)).toHaveLength(1);
});

test("late receipt after authenticated owner change stays in its original recovery scope", async ({ page }) => {
  await fixture(page); await change(page, { mode: "hold" });
  await page.getByRole("button", { name: "分叉当前对话", exact: true }).click(); await page.getByRole("button", { name: "创建分叉对话", exact: true }).click();
  await expect.poll(() => posts(page).then(values => values.length)).toBe(1);
  await page.evaluate(() => { const f = (window as any).historyFixture; f.connection.state.user = { id: "another_owner", role: "owner" }; f.update(); f.release(); });
  await expect(page.getByRole("dialog")).toHaveCount(0); await expect(page.getByRole("button", { name: "分叉当前对话", exact: true })).toBeEnabled();
  expect(await page.evaluate(() => (window as any).historyFixture.calls.filter(call => call.route === "/api/conversations"))).toHaveLength(0);
  await page.evaluate(() => { const f = (window as any).historyFixture; f.connection.state.user = { id: "owner", role: "owner" }; f.update(); });
  await page.getByRole("button", { name: "核对结果", exact: true }).click();
  await page.getByRole("dialog", { name: "核对历史操作", exact: true }).getByRole("button", { name: "核对结果", exact: true }).click();
  await expect(page.getByRole("heading", { name: "研究计划 · 分叉", exact: true })).toBeVisible(); expect(await posts(page)).toHaveLength(1);
});

test("unsupported native state still exposes a persisted Host receipt for read-only recovery", async ({ page }) => {
  await fixture(page, "?unsupported=1");
  await page.evaluate(() => { const f = (window as any).historyFixture; f.snapshot.pendingOperation = "remote_request"; f.operations.remote_request = { requestId: "remote_request", operationId: "remote_operation", state: "unknown", sourceRevision: "revision_a" }; f.history.refresh(); });
  await expect(page.getByRole("button", { name: "分叉当前对话", exact: true })).toHaveCount(0); await expect(page.getByRole("button", { name: "发送", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "核对结果", exact: true }).click(); await page.getByRole("dialog").getByRole("button", { name: "核对结果", exact: true }).click();
  await expect(page.getByRole("dialog").getByRole("alert")).toContainText("尚未确认"); expect(await posts(page)).toHaveLength(0);
  expect(await page.evaluate(() => (window as any).historyFixture.calls.filter(call => call.route.includes("/operations/")).map(call => call.method))).toEqual(["GET"]);
});

test("excluded native input and steering records cannot check or replay their old requests", async ({ page }) => {
  await fixture(page);
  await page.evaluate(() => { const f = (window as any).historyFixture; const base = { ...f.messages[0], historyContext: { excludedBy: "rewind_operation" } }; f.messages.push(
    { ...base, id: "stale_native", clientMsgId: "old_native", blocks: [{ type: "steering", botId: "bot", targetId: "old_run", mode: "message", outcome: "unknown", nativeInput: { state: "unknown" } }] },
    { ...base, id: "stale_steer", clientMsgId: "old_steer", blocks: [{ type: "steering", botId: "bot", targetId: "old_run", outcome: "unknown" }] }); f.update(); });
  await expect(page.getByRole("button", { name: "核对消息回执", exact: true })).toBeDisabled(); await expect(page.getByRole("button", { name: "核对引导回执", exact: true })).toBeDisabled();
  expect(await page.evaluate(() => (window as any).historyFixture.calls.filter(call => call.method === "POST"))).toHaveLength(0);
});

test("Pi-shaped capabilities allow whole and point forks without rewind; Kimi-shaped support stays whole-only", async ({ page }) => {
  await fixture(page);
  await page.evaluate(() => { const f = (window as any).historyFixture; f.snapshot.capabilities = { fork: true, anchoredFork: true, rewind: false }; f.anchors[0].rewind = false; f.history.refresh(); });
  await expect(page.getByRole("button", { name: "分叉当前对话", exact: true })).toBeEnabled();
  let menu = await pointMenu(page); await expect(menu.getByRole("menuitem", { name: "从此处分叉", exact: true })).toBeEnabled(); await expect(menu.getByRole("menuitem", { name: "回退到这条消息之前", exact: true })).toHaveCount(0);
  await menu.getByRole("menuitem", { name: "从此处分叉", exact: true }).click(); await expect(page.getByRole("dialog")).toContainText("这条消息之前的上下文"); await page.getByRole("button", { name: "取消", exact: true }).click();
  await page.evaluate(() => { const f = (window as any).historyFixture; f.snapshot.capabilities = { fork: true, anchoredFork: false, rewind: false }; f.history.refresh(); });
  menu = await pointMenu(page); await expect(menu.getByRole("menuitem", { name: "从此处分叉", exact: true })).toHaveCount(0); await expect(menu.getByRole("menuitem", { name: "回退到这条消息之前", exact: true })).toHaveCount(0); await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "分叉当前对话", exact: true }).click(); await expect(page.getByRole("dialog")).toContainText("新对话会沿用当前会话的上下文，原对话保持不变。"); expect(await posts(page)).toHaveLength(0);
});

test("source_missing without a revision disables attested actions and hides unadvertised support", async ({ page }) => {
  await fixture(page);
  await page.evaluate(() => { const f = (window as any).historyFixture; delete f.snapshot.revision; f.snapshot.blocked = "source_missing"; f.history.refresh(); });
  await expect(page.getByRole("button", { name: "分叉当前对话", exact: true })).toBeDisabled(); await expect(page.getByText("原生会话当前不可访问，请检查 Bot 状态。", { exact: true })).toBeVisible();
  await page.evaluate(() => { const f = (window as any).historyFixture; f.setLocale("en"); f.update(); });
  await expect(page.getByText("The native session is unavailable. Check the Bot status.", { exact: true })).toBeVisible();
  await page.evaluate(() => { const f = (window as any).historyFixture; f.snapshot.capabilities = { rewind: false, fork: false, anchoredFork: false }; f.history.refresh(); });
  await expect(page.getByRole("button", { name: "Fork current conversation", exact: true })).toHaveCount(0); expect(await posts(page)).toHaveLength(0);
});

test("a failed confirmation snapshot asks to refresh state without blaming local storage", async ({ page }) => {
  await fixture(page); await page.getByRole("button", { name: "分叉当前对话", exact: true }).click(); await change(page, { snapshotFailure: true });
  await page.getByRole("button", { name: "创建分叉对话", exact: true }).click();
  await expect(page.getByRole("alert")).toHaveText("请刷新会话状态后重试。"); expect(await posts(page)).toHaveLength(0);
  await expect(page.getByRole("button", { name: "创建分叉对话", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "取消", exact: true }).click(); await change(page, { snapshotFailure: false }); await page.locator("#refresh").click();
  await page.getByRole("button", { name: "分叉当前对话", exact: true }).click(); await expect(page.getByRole("button", { name: "创建分叉对话", exact: true })).toBeEnabled(); expect(await posts(page)).toHaveLength(0);
});

test("narrow English phone uses the same message actions, readable boundary and native Back", async ({ page }, info) => {
  await page.setViewportSize({ width: 320, height: 568 }); await fixture(page, "?en=1"); await message(page).click();
  const sheet = page.getByRole("dialog", { name: "Message actions", exact: true }); await expect(sheet).toBeVisible();
  await sheet.getByRole("button", { name: "Rewind to before this message", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Rewind to before this message?", exact: true }); await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("workspace files are not rolled back");
  const box = (await dialog.boundingBox())!; expect(box.x).toBeGreaterThanOrEqual(0); expect(box.x + box.width).toBeLessThanOrEqual(321);
  await dialog.getByRole("button", { name: "Rewind", exact: true }).scrollIntoViewIfNeeded();
  expect(await dialog.evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
  await page.screenshot({ path: info.outputPath("history-phone-en.png") });
  await page.evaluate(() => window.dispatchEvent(new Event("tarocub-native-back", { cancelable: true }))); await expect(dialog).toHaveCount(0); expect(await posts(page)).toHaveLength(0);
});
