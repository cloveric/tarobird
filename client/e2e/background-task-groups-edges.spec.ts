import { preparePairing } from "./fixtures/pairing-invite.js";
import { settleReadingLayout } from "./fixtures/reading-position.js";
// Regression cases independently reproduced by Opus during the group UI audit.
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
import { enterMobileChat, mobileHome } from "./fixtures/mobile.js";
import type { EngineTask } from "../../src/client-protocol/engine-tasks.js";
import type { EngineStreamEvent, ScopedEngineEvent } from "../../src/codex/adapter.js";

test.use({ serviceWorkers: "block" });
const names = ["抓取帖子与回帖", "下载 GitHub 视频", "读取上一期项目"];
const event = (i: number, inner: ScopedEngineEvent): EngineStreamEvent => ({ type: "scoped", origin: "bound", detached: true, scope: { id: `round_0_task_${i}`, kind: "subagent", label: names[i] }, event: inner });

async function setup(page: Page, tasksRoute?: (url: string, input?: { taskId?: string; requestId?: string }) => unknown) {
  const root = await mkdtemp(path.join(os.tmpdir(), "opus-ui-probe-")), stateDir = path.join(root, "bot"); await mkdir(stateDir);
  await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ engine: "claude", locale: "zh" }));
  const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve("dist") });
  const secret = randomBytes(32).toString("base64url"); await hub.store.db.run("INSERT INTO bots(id,name,secret_hash,engine) VALUES('bot','CC1',?,'claude')", [hashSecret(secret)]);
  const emitters: Array<(event: EngineStreamEvent) => void | Promise<void>> = [];
  if (tasksRoute) await page.route(/\/api\/conversations\/[^/]+\/tasks/, route => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(tasksRoute(route.request().url(), route.request().postDataJSON() ?? undefined)) }));
  const gateway: GatewayChannel = await attachGateway({ stateDir, url: hub.instanceUrl.replace("http", "ws") + "/instance", secret, botId: "bot", engine: "claude", runtime: createCoreServiceRuntime(), bridge: {
    handleAuthorizedMessage: async input => {
      emitters.push(input.onEngineEvent!);
      await input.onEngineEvent?.({ type: "assistant_text", text: "我安排了后台子代理分别处理素材。", delta: true });
      for (let i = 0; i < 3; i++) await input.onEngineEvent?.(event(i, { type: "tool_use", toolUseId: `read_${i}`, toolName: "Read", toolInput: { file_path: `素材_${i}.md` } }));
      await input.onEngineEvent?.(event(2, { type: "scope_status", status: "done" }));
      return { text: "后台任务已安排。" };
    },
  } });
  const chat = await hub.store.createConversation("owner", ["bot"], "素材整理", "direct");
  await page.goto(hub.url); await preparePairing(page, hub); await page.getByRole("button", { name: "配对此设备", exact: true }).click();
  await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
  await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" });
  if (page.viewportSize()!.width <= 760) { await expect(mobileHome(page)).toBeVisible(); await enterMobileChat(page, chat.title); }
  else { await expect(page.locator(".connection-pill.online")).toBeVisible(); await page.locator(".conversation-row").filter({ hasText: chat.title }).click(); }
  const cleanup = async () => { await page.close(); await gateway.disconnect(); await hub.close(); await rm(root, { recursive: true, force: true }); };
  return { hub, gateway, chat, emitters, cleanup };
}
async function start(page: Page) {
  await page.getByRole("textbox", { name: "消息", exact: true }).fill("把帖子、回帖和 GitHub 视频整理成素材。");
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  const card = page.locator(".background-task-group").first();
  await expect(card.locator(".background-task-row:visible")).toHaveCount(3);
  return card;
}

test("group pointer and keyboard menus never target only the anchor", async ({ page }, info) => {
  test.setTimeout(60_000); await page.setViewportSize({ width: 1360, height: 900 });
  const env = await setup(page);
  try {
    const card = await start(page);
    await card.locator(".background-group-heading").click({ button: "right" });
    const menu = page.getByRole("menu", { name: "消息操作" });
    await page.waitForTimeout(400);
    const opened = await menu.isVisible();
    const items = opened ? await menu.getByRole("menuitem").allInnerTexts() : [];
    console.log("F1 message menu opened on group:", opened, JSON.stringify(items));
    await page.screenshot({ path: info.outputPath("f1-group-contextmenu.png") });
    expect(opened, "group must not open a single-message menu").toBe(false);
    await card.locator(".background-task-row").first().focus(); await page.keyboard.press("Shift+F10");
    await expect(menu).toHaveCount(0);
  } finally { await env.cleanup(); }
});

test("standalone report handoff preserves its existing process reader", async ({ page }, info) => {
  test.setTimeout(60_000); await page.setViewportSize({ width: 1360, height: 900 });
  const env = await setup(page);
  try {
    const card = await start(page);
    await card.locator(".background-task-row:visible").nth(1).click();
    const dialog = page.getByRole("dialog", { name: "运行过程", exact: true });
    await expect(dialog).toBeVisible();
    await env.emitters[0]!(event(1, { type: "tool_result", toolUseId: "read_1", output: "视频已下载", exitCode: 0 }));
    await env.emitters[0]!(event(1, { type: "scope_status", status: "done" }));
    await env.emitters[0]!({ type: "task_notification", origin: "bound", scopeId: "round_0_task_1", status: "completed", text: "## 视频下载报告\n\n两段视频均已下载。" });
    await expect(page.locator(".native-run").filter({ hasText: "视频下载报告" })).toBeVisible();
    const snapshot = await env.hub.store.snapshot("owner", env.chat.id);
    const member = snapshot.messages.find(m => m.blocks.some(b => b.type === "card" && (b.extra as any)?.scopedRun && JSON.stringify(b).includes("视频下载报告")));
    console.log("F2 graduated card keeps group metadata:", !!(member?.blocks[0] as any)?.extra?.backgroundTaskGroup, "group rows now:", await card.locator(".background-task-row").count());
    await page.waitForTimeout(500);
    const still = await dialog.isVisible();
    console.log("F2 reader still open after graduation:", still, "activeElement:", await page.evaluate(() => document.activeElement?.tagName + "." + document.activeElement?.className));
    await page.screenshot({ path: info.outputPath("f2-after-graduation.png") });
    expect(still, "open process reader must survive its member leaving the group").toBe(true);
    await page.getByRole("button", { name: "关闭运行过程", exact: true }).click();
    await page.reload(); await page.locator(".conversation-row").filter({ hasText: env.chat.title }).click();
    await expect(page.getByRole("dialog", { name: "运行过程", exact: true })).toHaveCount(0);
  } finally { await env.cleanup(); }
});

test("finished groups do not hide unrelated running shell tasks", async ({ page }, info) => {
  test.setTimeout(60_000); await page.setViewportSize({ width: 1360, height: 900 });
  let shell = false;
  const env = await setup(page, () => ({ supported: true, tasks: shell ? [{ id: "shell_1", label: "npm run dev", kind: "shell", mode: "background", status: "running", canStop: true, updatedAt: Date.now() }] : [] }));
  try {
    const card = await start(page);
    for (const i of [0, 1]) await env.emitters[0]!(event(i, { type: "scope_status", status: "done" }));
    await expect(card).toHaveClass(/is-collapsed/); await expect(card).toContainText("3 个后台任务已完成");
    shell = true; await page.reload(); await page.locator(".conversation-row").filter({ hasText: env.chat.title }).click();
    await expect(page.locator(".background-task-group").first()).toContainText("3 个后台任务已完成");
    await page.waitForTimeout(1500);
    const trigger = page.locator(".engine-tasks-trigger");
    const present = await trigger.count(), visible = present ? await trigger.isVisible() : false;
    console.log("F3 engine trigger present:", present, "visible:", visible, "text:", present ? await trigger.innerText().catch(() => "") : "");
    await page.screenshot({ path: info.outputPath("f3-shell-trigger.png") });
    expect(visible, "running shell task needs its in-chat trigger").toBe(true);
  } finally { await env.cleanup(); }
});

test("F4 dock: group mounted in overscan but outside the scrollport counts as offscreen", async ({ page }, info) => {
  test.setTimeout(60_000); await page.setViewportSize({ width: 1360, height: 900 });
  const env = await setup(page);
  try {
    const card = await start(page);
    for (let i = 0; i < 4; i++) await env.gateway.send(env.chat.id, { text: `素材检查 ${i + 1}：原始记录、来源和时间戳均已保留。\n\n下一步继续核对视频片段与项目说明。\n\n补充行。\n\n补充行二。\n\n补充行三。\n\n补充行四。` });
    const scroller = page.locator(".message-scroll");
    await expect(page.getByText("素材检查 4：原始记录、来源和时间戳均已保留。", { exact: false }).first()).toBeVisible();
    // Four sufficiently tall rows leave room below the group to scroll it out
    // without dropping it from the four-row overscan. Enter history reading
    // through the real keyboard path so late row measurement cannot follow the
    // tail and override the measured position below.
    // Wait for parsed filler rows and stable virtual measurements.
    await settleReadingLayout(scroller);
    await scroller.press("Home");
    await expect(card).toBeInViewport();
    await expect(page.getByRole("button", { name: "回到最新消息", exact: true })).toBeVisible();
    await expect.poll(() => scroller.evaluate(node => new Promise<boolean>(resolve => {
      const group = node.querySelector<HTMLElement>(".background-task-group");
      if (!group) { resolve(false); return; }
      node.scrollTop += group.getBoundingClientRect().bottom - node.getBoundingClientRect().top + 20;
      requestAnimationFrame(() => requestAnimationFrame(() => {
        const settled = node.querySelector<HTMLElement>(".background-task-group");
        resolve(!!settled && settled.getBoundingClientRect().bottom < node.getBoundingClientRect().top - 10);
      }));
    }))).toBe(true);
    const geometry = await scroller.evaluate(node => { const g = node.querySelector<HTMLElement>(".background-task-group"); const b = node.getBoundingClientRect(); return g ? { mounted: true, bottom: g.getBoundingClientRect().bottom, top: b.top } : { mounted: false }; });
    const dock = page.getByRole("button", { name: "定位后台任务组", exact: true });
    console.log("F4 geometry:", JSON.stringify(geometry), "dock visible:", await dock.isVisible());
    await page.screenshot({ path: info.outputPath("f4-overscan.png") });
    await expect(dock).toBeVisible();
    await dock.click(); await expect(card).toBeInViewport(); await expect(dock).toHaveCount(0);
  } finally { await env.cleanup(); }
});

test("locating the anchor reveals its row in a folded group", async ({ page }, info) => {
  test.setTimeout(60_000); await page.setViewportSize({ width: 1360, height: 900 });
  const env = await setup(page);
  try {
    const card = await start(page);
    for (const i of [0, 1]) await env.emitters[0]!(event(i, { type: "scope_status", status: "done" }));
    await expect(card).toHaveClass(/is-collapsed/);
    // A quote from an old client can address the first original member.
    const id = await card.getAttribute("data-background-group-id");
    await env.gateway.send(env.chat.id, { text: "这一条再确认下" }, { replyTo: id! });
    // Use the new reply's own quote link. The last link on the page can still be
    // an earlier one until this reply renders, which located the wrong message.
    const reply = page.locator("article[data-message-id]").filter({ hasText: "这一条再确认下" });
    await expect(reply).toBeVisible();
    await reply.getByRole("button", { name: "查看回复对应的消息", exact: true }).click();
    await expect(page.locator(".focused-message .background-task-group")).toHaveCount(1);
    await page.waitForTimeout(400);
    const cls = await card.getAttribute("class"), rows = await card.locator(".background-task-row:visible").count();
    console.log("F5 after locating anchor member:", cls, "visible rows:", rows);
    await page.screenshot({ path: info.outputPath("f5-anchor-locate.png") });
    expect(rows, "located member row should be revealed like non-anchor members").toBeGreaterThan(0);
  } finally { await env.cleanup(); }
});

test("folded active groups honestly show offline uncertainty", async ({ page }, info) => {
  test.setTimeout(60_000); await page.setViewportSize({ width: 1360, height: 900 });
  const env = await setup(page);
  try {
    const card = await start(page);
    await card.locator(".background-group-heading").click();
    await expect(card).toHaveClass(/is-collapsed/);
    await env.gateway.disconnect();
    await page.waitForTimeout(2500);
    const heading = await card.locator(".background-group-heading").innerText();
    console.log("F6 collapsed heading while offline:", JSON.stringify(heading));
    await card.locator(".background-group-heading").click();
    console.log("F6 expanded heading while offline:", JSON.stringify(await card.locator(".background-group-heading").innerText()));
    await card.locator(".background-group-heading").click();
    await page.screenshot({ path: info.outputPath("f6-offline-collapsed.png") });
    expect(heading).toContain("待确认");
  } finally { await env.cleanup().catch(() => undefined); }
});

test("F7 same-group new member re-expands; sixth running member placement", async ({ page }, info) => {
  test.setTimeout(60_000); await page.setViewportSize({ width: 1360, height: 900 });
  const env = await setup(page);
  try {
    const card = await start(page);
    for (const i of [0, 1]) await env.emitters[0]!(event(i, { type: "scope_status", status: "done" }));
    await expect(card).toHaveClass(/is-collapsed/);
    const extra = (i: number, inner: ScopedEngineEvent): EngineStreamEvent => ({ type: "scoped", origin: "bound", detached: true, scope: { id: `round_0_task_${i}`, kind: "subagent", label: `追加任务 ${i}` }, event: inner });
    await env.emitters[0]!(extra(3, { type: "tool_use", toolUseId: "x3", toolName: "Read", toolInput: { file_path: "a.md" } }));
    await expect(card).toHaveClass(/is-expanded/);
    console.log("F7 re-expanded after new member:", await card.getAttribute("class"));
    await env.emitters[0]!(extra(3, { type: "scope_status", status: "done" }));
    await env.emitters[0]!(extra(4, { type: "tool_use", toolUseId: "x4", toolName: "Read", toolInput: { file_path: "b.md" } }));
    await env.emitters[0]!(extra(4, { type: "scope_status", status: "done" }));
    await env.emitters[0]!(extra(5, { type: "tool_use", toolUseId: "x5", toolName: "Read", toolInput: { file_path: "c.md" } }));
    await expect(card).toHaveClass(/is-expanded/);
    await page.waitForTimeout(400);
    const visible = await card.locator(".background-task-row:visible").evaluateAll(rows => rows.map(r => (r as HTMLElement).innerText.replace(/\s+/g, " ")));
    console.log("F7 heading:", JSON.stringify(await card.locator(".background-group-heading").innerText()), "visible rows:", JSON.stringify(visible), "more:", await card.locator(".background-group-more").innerText().catch(() => "-"));
    expect(visible).toHaveLength(5);
    expect(visible.some(row => row.includes("追加任务 5"))).toBe(true);
    await page.screenshot({ path: info.outputPath("f7-sixth-running.png") });
  } finally { await env.cleanup(); }
});

test("a finished group the user expanded stays expanded after virtualization remounts it", async ({ page }, info) => {
  test.setTimeout(90_000); await page.setViewportSize({ width: 1360, height: 900 });
  const env = await setup(page);
  try {
    const card = await start(page);
    for (const i of [0, 1]) await env.emitters[0]!(event(i, { type: "scope_status", status: "done" }));
    await expect(card).toHaveClass(/is-collapsed/);
    await card.locator(".background-group-heading").click(); await expect(card).toHaveClass(/is-expanded/);
    // Focus keeps a row mounted; release it so the virtual list may unmount the card.
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    for (let i = 0; i < 60; i++) await env.gateway.send(env.chat.id, { text: `填充消息 ${i + 1}\n\n第二段让行高更大一点，确保分组卡片离开虚拟窗口。` });
    const scroller = page.locator(".message-scroll");
    await expect.poll(async () => { await scroller.evaluate(node => { node.scrollTop = node.scrollHeight; }); return page.locator(".background-task-group").count(); }).toBe(0);
    // Enter history reading through real input; setting scrollTop alone while
    // still following the tail can be undone by late row measurements in WebKit.
    await scroller.press("Home");
    await expect.poll(async () => { await scroller.evaluate(node => { node.scrollTop = 0; }); return page.locator(".background-task-group").count(); }).toBe(1);
    await expect(page.locator(".background-task-group").first()).toHaveClass(/is-expanded/);
    await expect(page.locator(".background-task-group").first().locator(".background-task-row:visible")).toHaveCount(3);
    await page.screenshot({ path: info.outputPath("bg2-remount-expanded.png") });
  } finally { await env.cleanup(); }
});

for (const width of [390, 1360]) for (const theme of ["light", "dark"] as const) test(`unified tasks ${width} ${theme}: one dock keeps its group and all native controls`, async ({ page }, info) => {
  test.setTimeout(90_000); await page.setViewportSize({ width, height: 900 }); await page.emulateMedia({ colorScheme: theme });
  const tasks: EngineTask[] = [
    { id: "native_alpha", label: names[0]!, kind: "subagent", mode: "background", status: "running", canStop: true, updatedAt: Date.now() },
    // Same labels are deliberately not identity: never guess a join with cards.
    { id: "native_other", label: names[0]!, kind: "subagent", mode: "background", status: "running", canStop: true, updatedAt: Date.now() },
    { id: "native_done", label: names[2]!, kind: "subagent", mode: "background", status: "done", canStop: false, updatedAt: Date.now() },
    { id: "native_shell", label: "npm run dev", kind: "shell", mode: "background", status: "running", canStop: true, updatedAt: Date.now() },
  ];
  const stopped: string[] = [];
  const env = await setup(page, (_url, input) => {
    if (input?.taskId) { stopped.push(input.taskId); tasks.find(task => task.id === input.taskId)!.status = "stopped"; return { outcome: "accepted" }; }
    return { supported: true, tasks };
  });
  try {
    const card = await start(page), bar = page.locator(".conversation-task-bar"), manager = page.locator(".engine-tasks-trigger");
    // First-run appearance is explicitly light. Select the requested theme
    // for this task-control layout check instead of assuming OS theme wins.
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
    const canvas = await page.locator("html").evaluate(node => getComputedStyle(node).backgroundColor);
    const channels = canvas.match(/\d+/g)!.slice(0, 3).map(Number);
    if (theme === "dark") expect(Math.max(...channels)).toBeLessThan(80);
    else expect(Math.min(...channels)).toBeGreaterThan(200);
    await card.scrollIntoViewIfNeeded(); await expect(bar).toHaveCount(1); await expect(page.locator(".background-task-dock")).toHaveCount(0);
    await expect(manager).toContainText("1 个后台命令"); await expect(manager).not.toContainText("3 个任务执行中");
    await expect(card.getByRole("button", { name: /停止/ })).toHaveCount(0);
    await page.screenshot({ path: info.outputPath(`${width}-${theme}-visible.png`) });
    for (let i = 0; i < 16; i++) await env.gateway.send(env.chat.id, { text: `整理进展 ${i + 1}\n\n素材检查已保存，继续核对字幕与音频。\n\n来源和时间戳均已保留。` });
    const scroll = page.locator(".message-scroll"); await scroll.evaluate(node => { node.scrollTop = node.scrollHeight; });
    const dock = page.getByRole("button", { name: "定位后台任务组", exact: true });
    await expect(dock).toBeVisible(); await expect(bar).toHaveCount(1); await expect(bar.locator("button")).toHaveCount(2);
    await expect(dock).toContainText("本组"); await expect(dock).toContainText("2 运行中"); await expect(dock).toContainText("1 完成");
    await expect(manager).toContainText("1 个后台命令");
    const a = (await dock.boundingBox())!, b = (await manager.boundingBox())!;
    expect(Math.abs(a.y - b.y)).toBeLessThan(4); expect(a.x + a.width).toBeLessThanOrEqual(b.x + 2);
    if (width === 390) { expect(b.height).toBeGreaterThanOrEqual(44); expect(b.width).toBeGreaterThanOrEqual(44); }
    await page.screenshot({ path: info.outputPath(`${width}-${theme}-unified-dock.png`) });
    await manager.click(); const dialog = page.getByRole("dialog", { name: "子代理与后台任务", exact: true });
    await expect(dialog.getByRole("article")).toHaveCount(4); // Both same-name native tasks survive.
    await expect(dialog.getByRole("article", { name: "npm run dev", exact: true })).toContainText("执行中");
    await dialog.getByRole("article", { name: names[0]!, exact: true }).first().getByRole("button", { name: "停止此任务", exact: true }).click();
    await expect(dialog.getByRole("article", { name: names[0]!, exact: true }).filter({ hasText: "已停止" })).toHaveCount(1);
    expect(stopped).toEqual(["native_alpha"]);
    await dialog.getByRole("button", { name: "关闭任务列表", exact: true }).click(); await expect(manager).toBeFocused();
    await expect(dock).toContainText("2 运行中"); // A native ACK must never finish a saved group by guesswork.
    await dock.click(); await expect(card).toBeInViewport(); await expect(dock).toHaveCount(0);
    await card.locator(".background-task-row").first().click();
    const reader = page.getByRole("dialog", { name: "运行过程", exact: true }); await expect(reader).toBeVisible();
    for (const i of [0, 1]) await env.emitters[0]!(event(i, { type: "scope_status", status: "done" }));
    await expect(reader).toBeVisible(); await page.getByRole("button", { name: "关闭运行过程", exact: true }).click();
    await expect(card).toHaveClass(/is-collapsed/); await expect(card).toContainText("3 个后台任务已完成");
    await expect(manager).toContainText("2 个任务执行中"); // Unrelated agent/shell remain visible after the group finishes.
    await page.screenshot({ path: info.outputPath(`${width}-${theme}-completed.png`) });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(stopped).toHaveLength(1);
  } finally { await env.cleanup(); }
});

test("unified tasks: unsupported native manager retains the read-only group dock", async ({ page }) => {
  const env = await setup(page, () => ({ supported: false, tasks: [] }));
  try {
    const card = await start(page);
    for (let i = 0; i < 16; i++) await env.gateway.send(env.chat.id, { text: `旧版连接 ${i}\n\n仍可读取之前保存的任务卡。\n\n记录不会合并丢失。` });
    await page.locator(".message-scroll").evaluate(node => { node.scrollTop = node.scrollHeight; });
    const dock = page.getByRole("button", { name: "定位后台任务组", exact: true });
    await expect(dock).toBeVisible(); await expect(page.locator(".engine-tasks-trigger")).toHaveCount(0);
    await dock.click(); await expect(card).toBeInViewport(); await expect(dock).toHaveCount(0);
  } finally { await env.cleanup(); }
});

test("unified tasks: recovery stays legible and the dialog survives dock changes", async ({ page }, info) => {
  test.setTimeout(90_000); await page.setViewportSize({ width: 390, height: 844 });
  let pollFails = false;
  const env = await setup(page, () => pollFails ? {} : ({ supported: true, tasks: [{ id: "native_1", label: "检查字幕", kind: "subagent", mode: "background", status: "running", canStop: true, updatedAt: Date.now() }], foregroundStopScope: "subagents", recovery: { token: "native_fence", reason: "stop_unconfirmed" } }));
  try {
    await start(page);
    for (let i = 0; i < 16; i++) await env.gateway.send(env.chat.id, { text: `核对字幕 ${i}\n\n继续核对原始记录。\n\n检查来源。` });
    const scroll = page.locator(".message-scroll");
    // Release automatic tail-follow before moving the inert page under a modal.
    await scroll.press("Home"); await scroll.evaluate(node => { node.scrollTop = node.scrollHeight; });
    const dock = page.locator(".background-task-dock"), manager = page.locator(".engine-tasks-trigger");
    await expect(dock).toBeVisible(); await expect(manager).toContainText("停止尚未确认");
    expect(await manager.locator("span").evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath("390-recovery-dock.png") });
    await manager.evaluate(node => { (window as any).originalTaskTrigger = node; });
    await manager.click(); const dialog = page.getByRole("dialog", { name: "子代理与后台任务", exact: true }); await expect(dialog).toBeVisible();
    // Card visibility changes underneath an open portal must not remount the
    // manager, lose native receipts, or restore focus to a detached old trigger.
    await scroll.evaluate(node => { node.scrollTop = 0; }); await expect(dock).toHaveCount(0); await expect(dialog).toBeVisible();
    await scroll.evaluate(node => { node.scrollTop = node.scrollHeight; }); await expect(dock).toBeAttached(); await expect(dialog).toBeVisible();
    pollFails = true; await dialog.getByRole("button", { name: "刷新任务列表", exact: true }).click();
    await expect(manager).toContainText("停止尚未确认"); await expect(manager).toContainText("状态待确认");
    for (const text of await manager.locator("span,small").all()) expect(await text.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
    pollFails = false; await dialog.getByRole("button", { name: "刷新任务列表", exact: true }).click();
    await expect(manager).not.toContainText("状态待确认");
    for (const i of [0, 1]) await env.emitters[0]!(event(i, { type: "scope_status", status: "done" }));
    await expect(dock).toHaveCount(0); await expect(dialog).toBeVisible(); await expect(dialog).toContainText("新的消息暂不能执行");
    await dialog.getByRole("button", { name: "关闭任务列表", exact: true }).click(); await expect(manager).toBeFocused();
    expect(await manager.evaluate(node => node === (window as any).originalTaskTrigger)).toBe(true);
    await expect(manager).toContainText("停止尚未确认");
    await env.gateway.disconnect();
    await expect(manager).toContainText("停止尚未确认"); // Last known recovery must not be discarded on disconnect.
    await manager.click(); await expect(dialog).toContainText("连接中断，当前状态待确认");
    await expect(dialog.getByRole("button", { name: "强制结束此会话进程…", exact: true })).toBeDisabled();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  } finally { await env.cleanup(); }
});

test("unified tasks: the focused dock survives native tasks appearing and disappearing", async ({ page }) => {
  test.setTimeout(90_000); let nativePresent = false;
  const env = await setup(page, () => ({ supported: true, tasks: nativePresent ? [{ id: "native_1", label: "独立后台任务", kind: "subagent", mode: "background", status: "running", canStop: true, updatedAt: Date.now() }] : [] }));
  try {
    await start(page);
    for (let i = 0; i < 16; i++) await env.gateway.send(env.chat.id, { text: `保留原卡 ${i}\n\n继续整理。\n\n保留过程。` });
    // Keep normal tail-follow here: the test changes only native presence,
    // not history anchors. Wait until the actual latest message is painted.
    await expect(page.getByText("保留原卡 15", { exact: true })).toBeVisible();
    await page.locator(".message-scroll").evaluate(node => { node.scrollTop = node.scrollHeight; });
    // The modal makes the page inert; inspect the actual dock node even when
    // Chromium correctly removes it from the accessibility tree.
    const dock = page.locator(".background-task-dock"), manager = page.locator(".engine-tasks-trigger");
    await expect(dock).toBeVisible(); await expect(manager).toHaveCount(0);
    await dock.evaluate(node => { (window as any).originalDock = node; });
    nativePresent = true;
    await page.getByRole("textbox", { name: "消息", exact: true }).fill("/tasks");
    await page.getByRole("button", { name: "发送消息", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "子代理与后台任务", exact: true });
    await expect(dialog.getByRole("article")).toHaveCount(1);
    await expect(dock).toBeAttached();
    expect(await dock.evaluate(node => node === (window as any).originalDock)).toBe(true);
    await dialog.getByRole("button", { name: "关闭任务列表", exact: true }).click();
    await dock.focus(); nativePresent = false;
    await expect(manager).toHaveCount(0, { timeout: 10_000 });
    await expect(dock).toBeFocused();
    expect(await dock.evaluate(node => node === (window as any).originalDock)).toBe(true);
  } finally { await env.cleanup(); }
});


test("a handled task-group location does not undo folding after remount", async ({ page }) => {
  test.setTimeout(90_000); await page.setViewportSize({ width: 1360, height: 900 });
  const env = await setup(page);
  try {
    await start(page);
    for (let i = 0; i < 60; i++) await env.gateway.send(env.chat.id, { text: `后续消息 ${i + 1}\n\n这是用于检查历史阅读的独立内容。` });
    const scroller = page.locator(".message-scroll"), card = page.locator(".background-task-group").first();
    const dock = page.getByRole("button", { name: "定位后台任务组", exact: true });
    await settleReadingLayout(scroller);
    await scroller.evaluate(node => { node.scrollTop = node.scrollHeight; });
    await expect(dock).toBeVisible(); await dock.click();
    await expect(card).toBeInViewport(); await expect(card).toHaveClass(/is-expanded/);
    await card.locator(".background-group-heading").click(); await expect(card).toHaveClass(/is-collapsed/);
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await expect.poll(async () => { await scroller.evaluate(node => { node.scrollTop = node.scrollHeight; }); return card.count(); }).toBe(0);
    await scroller.press("Home");
    await expect.poll(async () => { await scroller.evaluate(node => { node.scrollTop = 0; }); return card.count(); }).toBe(1);
    await expect(card).toHaveClass(/is-collapsed/);
    // A new explicit location of that same task still reveals it.
    await scroller.evaluate(node => { node.scrollTop = node.scrollHeight; });
    await expect(dock).toBeVisible(); await dock.click();
    await expect(card).toBeInViewport(); await expect(card).toHaveClass(/is-expanded/);
    for (const i of [0, 1]) await env.emitters[0]!(event(i, { type: "scope_status", status: "done" }));
    await expect(card).toHaveClass(/is-collapsed/);
  } finally { await env.cleanup(); }
});
