import { preparePairing } from "./fixtures/pairing-invite.js";
import { test, expect, type Page } from "@playwright/test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { HubServer } from "../../src/hub/server.js";
import { HubPromptQueue } from "../../src/hub/prompt-queue.js";
import { hashSecret } from "../../src/hub/auth.js";
import { attachGateway } from "../../src/gateway/service.js";
import { createCoreServiceRuntime } from "../../src/core/runtime.js";
import type { GatewayChannel } from "../../src/gateway/channel.js";
import { blocksText } from "../../src/client-protocol/index.js";
import { showDisconnectedBots, selectConversation, waitForClientOnline } from "./fixtures/mobile.js";

// These tests deliberately hold HTTP reads. WebKit service-worker fetches bypass
// page.route, so keep interception deterministic; offline shell has its own suites.
test.use({ serviceWorkers: "block" });

async function pair(page: Page, hub: HubServer, title: string, offlineHistory = false) {
  await page.goto(hub.url); await preparePairing(page, hub); await page.getByRole("button", { name: "配对此设备", exact: true }).click();
  await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
  await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" });
  await waitForClientOnline(page);
  if (offlineHistory) await showDisconnectedBots(page);
  await selectConversation(page, title);
}

test("an owned queued prompt can cross an immutable Bus goal without offering edits to the goal", async ({ page }) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "queue-bus-barrier-"));
  const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve("dist") });
  try {
    for (const id of ["alpha", "beta"]) {
      await hub.store.db.run("INSERT INTO bots(id,name,secret_hash,engine,online) VALUES(?,?,?,'codex',1)", [id, id, "fixture"]);
      await hub.store.db.run("INSERT INTO managed_bots VALUES(?,?,?,?)", [id, "owner", id, "{}"]);
    }
    const queue = new HubPromptQueue(hub.store); await queue.registerWorker("alpha", true);
    const bus = await hub.agentBuses.create("owner", { requestId: "queue-bus", config: { name: "排队协作", mode: "ask", coordinator: { botId: "alpha" }, members: [{ botId: "beta" }] } });
    const conversationId = bus.coordinator.conversationId!;
    const prompt = (await hub.store.sendMessage("owner", { conversationId, clientMsgId: "prompt", text: "独立任务", attachments: [] })).message;
    const run = await hub.agentBuses.start("owner", bus.id, { requestId: "bus-goal", revision: bus.revision, text: "/review 协作任务" });
    const chat = await hub.store.conversationForBot("alpha", conversationId);
    await pair(page, hub, chat.title);
    await page.getByRole("button", { name: "管理待执行消息，共 2 条", exact: true }).click();
    const panel = page.getByRole("dialog", { name: "待执行消息", exact: true });
    const row = (id: string) => panel.locator(`[data-queue-message-id="${id}"]`);
    await expect(row(run.messageId).getByRole("button", { name: /编辑第|上移第|下移第|取消第/ })).toHaveCount(0);
    await expect(row(prompt.id).getByRole("button", { name: "下移第 1 条消息", exact: true })).toBeEnabled();
    await row(prompt.id).getByRole("button", { name: "下移第 1 条消息", exact: true }).click();
    await expect.poll(async () => (await queue.read("owner", "alpha", conversationId)).items.map(item => item.message.id)).toEqual([run.messageId, prompt.id]);
    await row(prompt.id).getByRole("button", { name: "上移第 2 条消息", exact: true }).click();
    await expect.poll(async () => (await queue.read("owner", "alpha", conversationId)).items.map(item => item.message.id)).toEqual([prompt.id, run.messageId]);
  } finally { await page.close(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});

for (const layout of ["phone", "desktop", "adhd"] as const) test(`move to front and end reorders one queued message and preserves drafts (${layout})`, async ({ page }, info) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "queue-front-"));
  const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve("dist") });
  try {
    await hub.profile.update({ name: "排队测试主机", revision: (await hub.profile.read()).revision });
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash,engine,online) VALUES('alpha','测试助手','fixture','claude',1)");
    const queue = new HubPromptQueue(hub.store); await queue.registerWorker("alpha", true);
    const chat = await hub.store.createConversation("owner", ["alpha"], "优先执行这条", "create");
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.push((await hub.store.sendMessage("owner", { conversationId: chat.id, clientMsgId: `front-${i}`, text: `排队任务 ${i + 1}`, attachments: [], ...(i === 4 ? { replyTo: ids[0] } : {}) })).message.id);
    const original = await hub.store.messageForUser("owner", ids[4]);
    await page.setViewportSize({ width: layout === "phone" ? 320 : 1500, height: 900 });
    await pair(page, hub, chat.title);
    if (layout === "adhd") {
      await page.getByRole("button", { name: "打开 ADHD 模式", exact: true }).click();
      await page.getByRole("checkbox", { name: `加入面板：排队测试主机 · ${chat.title}`, exact: true }).check();
    }
    const composer = page.locator(".composer textarea").filter({ visible: true }); await composer.fill("主输入框草稿");
    const open = () => page.getByRole("button", { name: "管理待执行消息，共 5 条", exact: true }).click(); await open();
    const panel = page.getByRole("dialog", { name: "待执行消息", exact: true });
    const rows = panel.locator(".prompt-queue-item"), row = (id: string) => panel.locator(`[data-queue-message-id="${id}"]`);
    const order = () => rows.evaluateAll(nodes => nodes.map(node => node.getAttribute("data-queue-message-id")));
    await expect(rows).toHaveCount(5);
    await expect(row(ids[0]).getByRole("button", { name: "将第 1 条消息移到最前", exact: true })).toBeDisabled();
    await expect(row(ids[4]).getByRole("button", { name: "将第 5 条消息移到最后", exact: true })).toBeDisabled();
    if (layout === "phone") {
      const heading = row(ids[1]).locator(".prompt-queue-item-heading");
      expect(await heading.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
      expect(await heading.locator("strong").evaluate(node => node.getBoundingClientRect().height)).toBeLessThan(22);
      expect(await heading.locator("time").evaluate(node => node.getBoundingClientRect().height)).toBeLessThan(20);
      expect(await row(ids[1]).locator(".prompt-queue-last").evaluate(node => { const r = node.getBoundingClientRect(); return r.width >= 44 && r.height >= 44; })).toBe(true);
    }
    await panel.screenshot({ path: info.outputPath(`queue-front-end-${layout}.png`) });
    await row(ids[1]).getByRole("button", { name: "编辑第 2 条消息", exact: true }).click();
    const editor = panel.getByRole("textbox", { name: "编辑待执行消息", exact: true }); await editor.fill("未保存的排队编辑");
    const writes: any[] = [];
    page.on("request", request => { if (request.method() === "POST" && request.url().endsWith(`/api/conversations/${chat.id}/queue`)) writes.push(request.postDataJSON()); });
    await row(ids[4]).getByRole("button", { name: "将第 5 条消息移到最前", exact: true }).click();
    let expected = [ids[4], ...ids.slice(0, 4)];
    await expect.poll(order).toEqual(expected);
    await expect.poll(async () => (await queue.read("owner", "alpha", chat.id)).items.filter(item => item.state === "queued").map(item => item.message.id)).toEqual(expected);
    expect(writes).toHaveLength(1);
    expect(writes[0].action).toEqual({ type: "move", messageId: ids[4], beforeId: ids[0] });
    await expect(row(ids[4]).getByRole("button", { name: "将第 1 条消息移到最前", exact: true })).toBeDisabled();
    await expect(editor).toHaveValue("未保存的排队编辑");
    const promoted = await hub.store.messageForUser("owner", ids[4]);
    expect(promoted.blocks).toEqual(original.blocks); expect(promoted.replyTo).toBe(original.replyTo);
    await row(ids[4]).getByRole("button", { name: "将第 1 条消息移到最后", exact: true }).click();
    expected = [...ids];
    await expect.poll(order).toEqual(expected);
    await expect.poll(async () => (await queue.read("owner", "alpha", chat.id)).items.filter(item => item.state === "queued").map(item => item.message.id)).toEqual(expected);
    expect(writes).toHaveLength(2);
    expect(writes[1].action).toEqual({ type: "move", messageId: ids[4], beforeId: null });
    await expect(row(ids[4]).getByRole("button", { name: "将第 5 条消息移到最后", exact: true })).toBeDisabled();
    await expect(editor).toHaveValue("未保存的排队编辑");
    const demoted = await hub.store.messageForUser("owner", ids[4]);
    expect(demoted.blocks).toEqual(original.blocks); expect(demoted.replyTo).toBe(original.replyTo);
    await panel.getByRole("button", { name: "放弃编辑", exact: true }).click();
    await panel.getByRole("button", { name: "关闭待执行消息", exact: true }).click();
    await expect(composer).toHaveValue("主输入框草稿");
    await page.reload(); await waitForClientOnline(page); await selectConversation(page, chat.title);
    await open(); await expect.poll(order).toEqual(expected);
  } finally { await page.close(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});

for (const direction of ["front", "end"] as const) test(`move to ${direction} respects command barriers and rejects a stale queue without replaying`, async ({ page }) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "queue-front-guards-"));
  const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve("dist") });
  try {
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash,engine,online) VALUES('alpha','测试助手','fixture','claude',1)");
    const queue = new HubPromptQueue(hub.store); await queue.registerWorker("alpha", true);
    const chat = await hub.store.createConversation("owner", ["alpha"], "队列边界", "create");
    const ids: string[] = [];
    for (const [i, text] of (direction === "front" ? ["第一项", "第二项", "第三项", "/new", "命令后的第四项"] : ["第一项", "/new", "命令后的第二项", "第三项", "第四项"]).entries()) ids.push((await hub.store.sendMessage("owner", { conversationId: chat.id, clientMsgId: `guard-${i}`, text, attachments: [] })).message.id);
    await page.setViewportSize({ width: 390, height: 844 }); await pair(page, hub, chat.title);
    await page.getByRole("button", { name: /管理待执行消息，共/ }).click();
    const panel = page.getByRole("dialog", { name: "待执行消息", exact: true });
    const row = (id: string) => panel.locator(`[data-queue-message-id="${id}"]`);
    const shortcut = direction === "front" ? ".prompt-queue-first" : ".prompt-queue-last";
    await expect(row(ids[direction === "front" ? 3 : 1]).locator(shortcut)).toHaveCount(0);
    await expect(row(ids[direction === "front" ? 4 : 0]).locator(shortcut)).toBeDisabled();
    let writes = 0;
    await page.route(`**/api/conversations/${chat.id}/queue`, async route => {
      if (route.request().method() !== "POST") return route.continue();
      writes++;
      const snapshot = await queue.read("owner", "alpha", chat.id);
      await queue.mutate("owner", chat.id, { botId: "alpha", requestId: "concurrent-front", revision: snapshot.revision, action: { type: "move", messageId: ids[direction === "front" ? 1 : 4], beforeId: ids[direction === "front" ? 0 : 3] } });
      await route.continue();
    });
    await row(ids[2]).locator(shortcut).click();
    await expect(panel.getByRole("alert")).toContainText("队列已变化");
    const expected = direction === "front" ? [ids[1], ids[0], ...ids.slice(2)] : [...ids.slice(0,3),ids[4],ids[3]];
    await expect.poll(() => panel.locator(".prompt-queue-item").evaluateAll(nodes => nodes.map(node => node.getAttribute("data-queue-message-id")))).toEqual(expected);
    expect((await queue.read("owner", "alpha", chat.id)).items.filter(item => item.state === "queued").map(item => item.message.id)).toEqual(expected);
    expect(writes).toBe(1);
    await expect(row(ids[2]).locator(shortcut)).toBeEnabled();
  } finally { await page.close(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});

for (const adhd of [false, true]) test(`queue context menu locates the exact bubble and keeps both drafts (${adhd ? "ADHD" : "chat"})`, async ({ page }, info) => {
  test.setTimeout(90_000);
  const root = await mkdtemp(path.join(os.tmpdir(), "queue-locate-"));
  const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve("dist") });
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  try {
    await hub.profile.update({ name: "定位测试主机", revision: (await hub.profile.read()).revision });
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash,engine,online) VALUES('alpha','测试助手','fixture','claude',1)");
    const queue = new HubPromptQueue(hub.store); await queue.registerWorker("alpha", true);
    const chat = await hub.store.createConversation("owner", ["alpha"], "队列定位对话", "create");
    const ids: string[] = [];
    for (let i = 0; i < 70; i++) {
      // Identical prompts must still locate the exact underlying message ID.
      ids.push((await hub.store.sendMessage("owner", { conversationId: chat.id, clientMsgId: `pending-${i}`, text: i < 2 ? "内容相同的两条待执行消息" : `后续任务 ${i}：` + "保留自己的聊天位置。".repeat(4), attachments: [] })).message.id);
      await new Promise(resolve => setTimeout(resolve, 2));
    }
    await page.setViewportSize({ width: 1500, height: 900 }); await pair(page, hub, chat.title);
    if (adhd) {
      await page.getByRole("button", { name: "打开 ADHD 模式", exact: true }).click();
      await page.getByRole("checkbox", { name: `加入面板：定位测试主机 · ${chat.title}`, exact: true }).check();
    }
    const composer = page.locator(".composer textarea").filter({ visible: true }); await composer.fill("未发送的主输入框草稿");
    const bubble = page.locator(`[data-message-id="${ids[0]}"]`).filter({ visible: true });
    await expect(bubble).not.toBeInViewport();
    const initial = await queue.read("owner", "alpha", chat.id);
    const open = () => page.getByRole("button", { name: /管理待执行消息，共/ }).click(); await open();
    const panel = page.getByRole("dialog", { name: "待执行消息", exact: true });
    const item = panel.locator(`[data-queue-message-id="${ids[0]}"]`);
    await item.getByRole("button", { name: "编辑第 1 条消息", exact: true }).click();
    const editor = panel.getByRole("textbox", { name: "编辑待执行消息", exact: true }); await editor.fill("未保存的队列修改");
    await item.locator(".prompt-queue-text").click({ button: "right" });
    const menu = panel.getByRole("menu", { name: "待执行消息操作", exact: true });
    await expect(menu).toBeVisible();
    await page.screenshot({ path: info.outputPath(`queue-menu-${adhd ? "adhd" : "chat"}.png`) });
    await menu.getByRole("menuitem", { name: "定位到对话气泡", exact: true }).click();
    await expect(panel).toHaveCount(0); await expect(bubble).toHaveClass(/focused-message/); await expect(bubble).toBeInViewport();
    await expect(bubble).toContainText("内容相同的两条待执行消息");
    await expect(page.locator(`[data-message-id="${ids[1]}"]`)).not.toHaveClass(/focused-message/);
    await expect(composer).toHaveValue("未发送的主输入框草稿");
    expect((await queue.read("owner", "alpha", chat.id)).revision).toBe(initial.revision);
    expect(blocksText((await hub.store.messageForUser("owner", ids[0])).blocks)).toBe("内容相同的两条待执行消息");
    await page.screenshot({ path: info.outputPath(`queue-located-${adhd ? "adhd" : "chat"}.png`) });
    await open(); await expect(editor).toHaveValue("未保存的队列修改");
    await panel.getByRole("button", { name: "放弃编辑", exact: true }).click();
    await item.focus(); await item.press("Shift+F10"); await expect(menu).toBeVisible();
    await page.keyboard.press("Escape"); await expect(menu).toHaveCount(0); await expect(panel).toBeVisible(); await expect(item).toBeFocused();
    // Reordering while the menu is open must not retarget it to the new first row.
    await item.press("Shift+F10");
    await queue.mutate("owner", chat.id, { botId: "alpha", requestId: "move-while-menu-open", revision: initial.revision, action: { type: "move", messageId: ids[1], beforeId: ids[0] } });
    await expect(panel.locator(".prompt-queue-item").first()).toHaveAttribute("data-queue-message-id", ids[1]);
    if (!await menu.isVisible()) { await item.focus(); await item.press("Shift+F10"); }
    await page.keyboard.press("Enter");
    await expect(panel).toHaveCount(0); await expect(bubble).toHaveClass(/focused-message/); await expect(bubble).toBeInViewport();
    await open(); await item.locator(".prompt-queue-text").click({ button: "right" }); await expect(menu).toBeVisible();
    // A target that leaves the pending queue cannot leave an actionable stale menu.
    const changed = await queue.read("owner", "alpha", chat.id);
    await queue.mutate("owner", chat.id, { botId: "alpha", requestId: "cancel-while-menu-open", revision: changed.revision, action: { type: "cancel", messageId: ids[0] } });
    await expect(item).toHaveCount(0); await expect(menu).toHaveCount(0); await expect(panel).toBeVisible();
    await expect(composer).toHaveValue("未发送的主输入框草稿");
    expect(errors).toEqual([]);
  } finally { await page.close(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});

for (const platform of ["MacIntel", "Win32"]) for (const adhd of [false, true]) test(`queue editor Alt+Enter preserves selection, draft and explicit save (${platform}, ${adhd ? "ADHD" : "chat"})`, async ({ page }, info) => {
  await page.addInitScript(value => Object.defineProperty(navigator, "platform", { get: () => value }), platform);
  const root = await mkdtemp(path.join(os.tmpdir(), "queue-newline-"));
  const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve("dist") });
  try {
    await hub.profile.update({ name: "换行测试主机", revision: (await hub.profile.read()).revision });
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash,engine,online) VALUES('alpha','测试助手','fixture','claude',1)");
    const queue = new HubPromptQueue(hub.store); await queue.registerWorker("alpha", true);
    const chat = await hub.store.createConversation("owner", ["alpha"], "编辑排队换行", "create");
    const message = (await hub.store.sendMessage("owner", { conversationId: chat.id, clientMsgId: "pending", text: "hello 中文", attachments: [] })).message;
    await page.setViewportSize({ width: 1500, height: 850 }); await pair(page, hub, chat.title);
    if (adhd) {
      await page.getByRole("button", { name: "打开 ADHD 模式", exact: true }).click();
      await page.getByRole("checkbox", { name: `加入面板：换行测试主机 · ${chat.title}`, exact: true }).check();
    }
    const composer = page.locator(".composer textarea").filter({ visible: true });
    await composer.fill("主输入框草稿");
    const trigger = page.getByRole("button", { name: "管理待执行消息，共 1 条", exact: true }); await trigger.click();
    const panel = page.getByRole("dialog", { name: "待执行消息", exact: true });
    await panel.getByRole("button", { name: "编辑第 1 条消息", exact: true }).click();
    const editor = panel.getByRole("textbox", { name: "编辑待执行消息", exact: true });
    // Queue editing keeps dialog typography when the chat reading size grows.
    await page.evaluate(() => { document.documentElement.style.fontSize = "18px"; });
    await expect(editor).toHaveCSS("font-size", "14px");
    if (!adhd) {
      await expect(composer).toHaveCSS("font-size", "18px");
      expect(await composer.evaluate(node => getComputedStyle(node).getPropertyValue("--composer-text-lift").trim())).toBe("8px");
    }
    expect(await editor.evaluate(node => getComputedStyle(node).getPropertyValue("--composer-text-lift").trim())).toBe("");
    const initial = await queue.read("owner", "alpha", chat.id);
    await editor.focus(); await editor.evaluate((node: HTMLTextAreaElement) => node.setSelectionRange(5, 6));
    await editor.press("Alt+Enter"); await expect(editor).toHaveValue("hello\n中文");
    expect(await editor.evaluate((node: HTMLTextAreaElement) => [node.selectionStart, node.selectionEnd])).toEqual([6, 6]);
    await editor.press("ControlOrMeta+z"); await expect(editor).toHaveValue("hello 中文");
    await expect(editor).toBeFocused();
    // WebKit's document undo can otherwise include the inert composer draft.
    await expect(composer).toHaveValue("主输入框草稿");
    await editor.press("ControlOrMeta+Shift+z"); await expect(editor).toHaveValue("hello\n中文");
    await expect(composer).toHaveValue("主输入框草稿");
    await editor.press("ControlOrMeta+z"); await expect(editor).toHaveValue("hello 中文");
    await expect(composer).toHaveValue("主输入框草稿");
    // Synthetic IME keys must not be claimed or insert an extra newline.
    for (const ime of [{ isComposing: true, keyCode: 13 }, { isComposing: false, keyCode: 229 }]) {
      expect(await editor.evaluate((node, init) => node.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", altKey: true, bubbles: true, cancelable: true, ...init })), ime)).toBe(true);
      await expect(editor).toHaveValue("hello 中文");
    }
    await editor.evaluate((node: HTMLTextAreaElement) => node.setSelectionRange(5, 6));
    await editor.press("Alt+Enter"); await expect(editor).toHaveValue("hello\n中文");
    await editor.evaluate((node: HTMLTextAreaElement) => node.setSelectionRange(node.value.length, node.value.length));
    await editor.press("Enter"); await editor.pressSequentially("next");
    await editor.press("Shift+Enter"); await editor.pressSequentially("last");
    await expect(editor).toHaveValue("hello\n中文\nnext\nlast");
    await page.evaluate(() => { document.execCommand = () => false; });
    await editor.press("Alt+Enter"); await editor.pressSequentially("fallback");
    const edited = "hello\n中文\nnext\nlast\nfallback";
    await expect(editor).toHaveValue(edited);
    expect((await queue.read("owner", "alpha", chat.id)).revision).toBe(initial.revision);
    expect(blocksText((await hub.store.messageForUser("owner", message.id)).blocks)).toBe("hello 中文");
    await panel.getByRole("button", { name: "关闭待执行消息", exact: true }).click();
    await expect(composer).toHaveValue("主输入框草稿"); await trigger.click();
    await expect(editor).toHaveValue(edited);
    const save = panel.getByRole("button", { name: "保存修改", exact: true });
    const originalSaveFill = await save.evaluate(el => getComputedStyle(el).backgroundColor);
    await page.evaluate(() => { document.documentElement.dataset.monoAccent = 'mist'; });
    await expect.poll(() => save.evaluate(el => getComputedStyle(el).backgroundColor)).not.toBe(originalSaveFill);
    await save.screenshot({ path: info.outputPath('accent-save.png'), animations: 'disabled' });
    await save.click();
    await expect(panel.getByRole("status")).toContainText("待执行消息已更新");
    expect(blocksText((await hub.store.messageForUser("owner", message.id)).blocks)).toBe(edited);
    expect((await hub.store.snapshot("owner", chat.id)).messages).toHaveLength(1);
    await panel.getByRole("button", { name: "关闭待执行消息", exact: true }).click();
    await page.reload(); await waitForClientOnline(page);
    await expect(composer).toHaveValue("主输入框草稿");
  } finally { await page.close(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});

test("long queues scroll inside their drawer without overflowing ADHD or ordinary chat", async ({ page }, info) => {
  test.setTimeout(90_000);
  const root = await mkdtemp(path.join(os.tmpdir(), "prompt-queue-layout-"));
  const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve("dist") });
  try {
    await hub.profile.update({ name: "队列测试主机", revision: (await hub.profile.read()).revision });
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash,engine,online) VALUES('alpha','测试助手','fixture','claude',1)");
    const queue = new HubPromptQueue(hub.store);
    await queue.registerWorker("alpha", true);
    const chat = await hub.store.createConversation("owner", ["alpha"], "长队列布局", "create");
    for (let i = 1; i <= 12; i++) await hub.store.sendMessage("owner", { conversationId: chat.id, clientMsgId: `pending-${i}`, text: `排队任务 ${i}：` + "请保留消息与队列的独立滚动。".repeat(i === 1 ? 30 : 5), attachments: [] });
    await page.setViewportSize({ width: 1500, height: 850 });
    await pair(page, hub, chat.title);
    await page.addStyleTag({ content: "::-webkit-scrollbar{width:16px;height:16px}::-webkit-scrollbar-thumb{background:#111}" });
    const panel = page.getByRole("dialog", { name: "待执行消息", exact: true });
    const bounded = async () => {
      await expect.poll(() => page.evaluate(() => {
        const root = document.documentElement;
        return [root.scrollWidth - root.clientWidth, root.scrollHeight - root.clientHeight];
      })).toEqual([0, 0]);
    };
    for (const adhd of [false, true]) {
      if (adhd) {
        await page.getByRole("button", { name: "打开 ADHD 模式", exact: true }).click();
        await page.getByRole("checkbox", { name: `加入面板：队列测试主机 · ${chat.title}`, exact: true }).check();
      }
      for (const width of [1500, 1100]) {
        await page.setViewportSize({ width, height: 850 });
        await bounded();
        if (adhd) {
          await page.getByRole("button", { name: "打开 Agent Bus", exact: true }).click();
          const bus = page.getByRole("complementary", { name: "Agent Bus 设置与运行", exact: true });
          await expect(bus).toBeVisible();
          await bus.getByRole("button", { name: "收起 Agent Bus", exact: true }).click();
          await expect(bus).toBeHidden();
          await bounded();
        }
        const trigger = page.getByRole("button", { name: "管理待执行消息，共 12 条", exact: true });
        await trigger.click();
        await expect(panel.locator(".prompt-queue-item")).toHaveCount(12);
        await bounded();
        const list = panel.locator(".prompt-queue-list");
        await panel.getByRole("button", { name: "查看全文", exact: true }).first().click();
        await bounded();
        await panel.getByRole("button", { name: "下移第 1 条消息", exact: true }).click();
        await expect(panel.locator(".prompt-queue-text").first()).toContainText("排队任务 2：");
        await panel.getByRole("button", { name: "上移第 2 条消息", exact: true }).click();
        await expect(panel.locator(".prompt-queue-text").first()).toContainText("排队任务 1：");
        await bounded();
        await expect.poll(() => list.evaluate(e => e.scrollHeight - e.clientHeight)).toBeGreaterThan(200);
        await list.evaluate(e => { e.scrollTop = e.scrollHeight; });
        await expect(panel.getByRole("button", { name: "编辑第 12 条消息", exact: true })).toBeInViewport();
        await panel.getByRole("button", { name: "编辑第 12 条消息", exact: true }).click();
        const editor = panel.getByRole("textbox", { name: "编辑待执行消息", exact: true });
        await editor.fill("未保存的队列修改");
        await expect(editor).toBeInViewport();
        await bounded();
        await page.screenshot({ path: info.outputPath(`queue-${adhd ? "adhd" : "chat"}-${width}.png`) });
        await panel.getByRole("button", { name: "关闭待执行消息", exact: true }).click();
        await bounded();
        await expect(trigger).toBeFocused();
        await trigger.click();
        await expect(editor).toHaveValue("未保存的队列修改");
        await panel.getByRole("button", { name: "放弃编辑", exact: true }).click();
        await panel.getByRole("button", { name: "关闭待执行消息", exact: true }).click();
        await bounded();
      }
    }
  } finally { await page.close(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});

test("slow queue reads remain usable while polling and manual refresh continue", async ({ page }) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "prompt-queue-slow-read-"));
  const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve("dist") });
  try {
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash,engine) VALUES('alpha','Claude 助手','fixture','claude')");
    const queue = new HubPromptQueue(hub.store);
    await queue.registerWorker("alpha", true);
    const chat = await hub.store.createConversation("owner", ["alpha"], "慢速队列读取", "create");
    const message = (await hub.store.sendMessage("owner", { conversationId: chat.id, clientMsgId: "pending", text: "尚未执行的内容", attachments: [] })).message;
    await page.route(`**/api/conversations/${chat.id}/queue?*`, async route => {
      // Longer than the two-second polling interval, shorter than the timeout.
      await new Promise(resolve => setTimeout(resolve, 3000));
      await route.continue().catch(() => {});
    });
    await pair(page, hub, chat.title, true);
    const trigger = page.getByRole("button", { name: "管理待执行消息，共 1 条", exact: true });
    await expect(trigger).toBeVisible({ timeout: 8500 });
    await trigger.click();
    const panel = page.getByRole("dialog", { name: "待执行消息", exact: true });
    await expect(panel).toContainText("尚未执行的内容");
    const snapshot = await queue.read("owner", "alpha", chat.id);
    await queue.mutate("owner", chat.id, { botId: "alpha", requestId: "remote-edit", revision: snapshot.revision, action: { type: "edit", messageId: message.id, text: "另一台设备修改的内容" } });
    await panel.getByRole("button", { name: "刷新待执行消息", exact: true }).click();
    await expect(panel).toContainText("另一台设备修改的内容", { timeout: 8500 });
  } finally { await page.unrouteAll({ behavior: "ignoreErrors" }); await page.close(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});

test("saving during a refresh ends its loading state and ignores the older read", async ({ page }) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "prompt-queue-refresh-save-"));
  const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve("dist") });
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  try {
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash,engine) VALUES('alpha','Claude 助手','fixture','claude')");
    await new HubPromptQueue(hub.store).registerWorker("alpha", true);
    const chat = await hub.store.createConversation("owner", ["alpha"], "刷新期间调整顺序", "create");
    for (const [index, text] of ["第一条任务", "第二条任务"].entries()) await hub.store.sendMessage("owner", { conversationId: chat.id, clientMsgId: `pending_${index}`, text, attachments: [] });
    await pair(page, hub, chat.title, true);
    const trigger = page.getByRole("button", { name: "管理待执行消息，共 2 条", exact: true });
    await expect(trigger).toBeVisible();
    let captured = false;
    await page.route(`**/api/conversations/${chat.id}/queue?*`, async route => {
      if (captured) { await held; await route.continue().catch(() => {}); return; }
      captured = true;
      const response = await route.fetch();
      await held;
      await route.fulfill({ response }).catch(() => {});
    });
    await trigger.click();
    await expect.poll(() => captured).toBe(true);
    const panel = page.getByRole("dialog", { name: "待执行消息", exact: true });
    await expect(panel.getByRole("status")).toHaveText("正在刷新…");
    await panel.getByRole("button", { name: "上移第 2 条消息", exact: true }).click();
    await expect(panel.locator(".prompt-queue-item").first()).toContainText("第二条任务");
    await expect(panel.getByRole("status")).toHaveText("消息已移到第 1 条", { timeout: 1000 });
    release();
    await panel.getByRole("button", { name: "刷新待执行消息", exact: true }).click();
    await expect(panel.getByRole("status")).not.toHaveText("正在刷新…");
    await expect(panel.locator(".prompt-queue-item").first()).toContainText("第二条任务");
  } finally { release(); await page.unrouteAll({ behavior: "ignoreErrors" }); await page.close(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});

test("manual refresh reads fresh state while an older snapshot is still in flight", async ({ page }) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "prompt-queue-refresh-fresh-"));
  const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve("dist") });
  let release!: () => void, captured!: () => void, returned!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const reading = new Promise<void>(resolve => { captured = resolve; });
  const finished = new Promise<void>(resolve => { returned = resolve; });
  try {
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash,engine) VALUES('alpha','Claude 助手','fixture','claude')");
    const queue = new HubPromptQueue(hub.store); await queue.registerWorker("alpha", true);
    const chat = await hub.store.createConversation("owner", ["alpha"], "刷新读取最新状态", "create");
    const message = (await hub.store.sendMessage("owner", { conversationId: chat.id, clientMsgId: "pending", text: "修改前的文字", attachments: [] })).message;
    await pair(page, hub, chat.title, true);
    await page.getByRole("button", { name: "管理待执行消息，共 1 条", exact: true }).click();
    const panel = page.getByRole("dialog", { name: "待执行消息", exact: true });
    await expect(panel.getByRole("status")).not.toHaveText("正在刷新…");
    let first = true;
    await page.route(`**/api/conversations/${chat.id}/queue?*`, async route => {
      if (!first) { await route.continue().catch(() => {}); return; }
      first = false;
      const response = await route.fetch(); captured();
      await held;
      await route.fulfill({ response }).catch(() => {}); returned();
    });
    await reading;
    const snapshot = await queue.read("owner", "alpha", chat.id);
    await queue.mutate("owner", chat.id, { botId: "alpha", requestId: "remote_edit", revision: snapshot.revision, action: { type: "edit", messageId: message.id, text: "修改后的最新文字" } });
    await panel.getByRole("button", { name: "刷新待执行消息", exact: true }).click();
    await expect(panel).toContainText("修改后的最新文字");
    await expect(panel.getByRole("status")).not.toHaveText("正在刷新…");
    release(); await finished;
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await expect(panel.locator(".prompt-queue-text")).toHaveText("修改后的最新文字");
  } finally { release(); await page.unrouteAll({ behavior: "ignoreErrors" }); await page.close(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});

for (const phone of [false, true]) {
  test(`${phone ? "phone" : "desktop"}: cancellation confirms the version the user actually reviewed`, async ({ browser }) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "prompt-queue-confirm-version-"));
    const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve("dist") });
    const context = await browser.newContext({ viewport: phone ? { width: 390, height: 844 } : { width: 1360, height: 900 }, isMobile: phone, hasTouch: phone });
    const page = await context.newPage();
    try {
      await hub.store.db.run("INSERT INTO bots(id,name,secret_hash,engine) VALUES('alpha','Claude 助手','fixture','claude')");
      const queue = new HubPromptQueue(hub.store); await queue.registerWorker("alpha", true);
      const chat = await hub.store.createConversation("owner", ["alpha"], "取消前核对内容", "create");
      const message = (await hub.store.sendMessage("owner", { conversationId: chat.id, clientMsgId: "pending", text: "我准备取消的旧任务", attachments: [] })).message;
      await pair(page, hub, chat.title, true);
      await page.getByRole("button", { name: "管理待执行消息，共 1 条", exact: true }).click();
      const panel = page.getByRole("dialog", { name: "待执行消息", exact: true });
      await panel.getByRole("button", { name: "编辑第 1 条消息", exact: true }).click();
      await page.evaluate(() => Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined }));
      await panel.getByRole("button", { name: "复制文字", exact: true }).click();
      await expect(panel.getByRole("alert")).toContainText("复制失败，请选择文字后复制。");
      await expect(panel.getByRole("textbox", { name: "编辑待执行消息", exact: true })).toHaveValue("我准备取消的旧任务");
      await panel.getByRole("button", { name: "放弃编辑", exact: true }).click();
      await panel.getByRole("button", { name: "取消第 1 条待执行消息", exact: true }).click();
      const before = await queue.read("owner", "alpha", chat.id);
      await queue.mutate("owner", chat.id, { botId: "alpha", requestId: "other_device_edit", revision: before.revision, action: { type: "edit", messageId: message.id, text: "另一台设备刚修订的重要任务" } });
      // Polling has already updated the row. It must not silently update the
      // revision attached to the user's still-open destructive confirmation.
      await expect(panel.locator(".prompt-queue-text")).toHaveText("另一台设备刚修订的重要任务");
      await panel.getByRole("button", { name: "确认取消排队", exact: true }).click();
      await expect(panel.getByRole("alert")).toContainText("队列已变化");
      expect((await queue.read("owner", "alpha", chat.id)).items.map(item => item.message.id)).toEqual([message.id]);
      // Reviewing the fresh task and explicitly confirming again can cancel it.
      await panel.getByRole("button", { name: "取消第 1 条待执行消息", exact: true }).click();
      await panel.getByRole("button", { name: "确认取消排队", exact: true }).click();
      await expect(panel).toContainText("没有待执行的消息");
      expect((await queue.read("owner", "alpha", chat.id)).items).toHaveLength(0);
    } finally { await context.close(); await hub.close(); await rm(root, { recursive: true, force: true }); }
  });

  test(`${phone ? "phone" : "desktop"}: dispatch removes an open cancellation confirmation`, async ({ browser }) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "prompt-queue-confirm-claim-"));
    const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve("dist") });
    const context = await browser.newContext({ viewport: phone ? { width: 390, height: 844 } : { width: 1360, height: 900 }, isMobile: phone, hasTouch: phone });
    const page = await context.newPage();
    try {
      await hub.store.db.run("INSERT INTO bots(id,name,secret_hash,engine) VALUES('alpha','Claude 助手','fixture','claude')");
      const queue = new HubPromptQueue(hub.store); await queue.registerWorker("alpha", true);
      const chat = await hub.store.createConversation("owner", ["alpha"], "取消确认期间开始执行", "create");
      const message = (await hub.store.sendMessage("owner", { conversationId: chat.id, clientMsgId: "pending", text: "即将交给 Bot 的任务", attachments: [] })).message;
      await pair(page, hub, chat.title, true);
      await page.getByRole("button", { name: "管理待执行消息，共 1 条", exact: true }).click();
      const panel = page.getByRole("dialog", { name: "待执行消息", exact: true });
      await panel.getByRole("button", { name: "取消第 1 条待执行消息", exact: true }).click();
      await expect(panel.getByRole("button", { name: "确认取消排队", exact: true })).toBeEnabled();
      expect((await queue.claim("alpha", true, false)).map(item => item.id)).toEqual([message.id]);
      await expect(panel.locator(".prompt-queue-item")).toHaveCount(0);
      await expect(panel.getByRole("button", { name: "确认取消排队", exact: true })).toHaveCount(0);
      expect((await queue.read("owner", "alpha", chat.id)).items[0]?.state).toBe("dispatched");
    } finally { await context.close(); await hub.close(); await rm(root, { recursive: true, force: true }); }
  });
}

test("host queue: desktop and phone share authoritative order, edits, cancellation and uncertain-operation receipts", async ({ browser }, info) => {
  test.setTimeout(120000);
  const secondPrompt = "第二项待处理：" + "这段文字需要完整查看才能确定调整顺序。".repeat(5);
  const root = await mkdtemp(path.join(os.tmpdir(), "prompt-queue-ui-")), stateDir = path.join(root, "bot");
  await mkdir(stateDir); await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ engine: "claude", locale: "zh" }));
  const hub = await HubServer.start({ stateDir: path.join(root, "hub"), clientDir: path.resolve("dist") });
  const desktopContext = await browser.newContext({ viewport: { width: 1360, height: 900 } }), phoneContext = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const desktop = await desktopContext.newPage(), phone = await phoneContext.newPage(), calls: string[] = [], errors: string[] = [];
  await phone.addInitScript(() => {
    const visual = Object.assign(new EventTarget(), { height: innerHeight, width: innerWidth, offsetTop: 0, offsetLeft: 0, scale: 1 });
    Object.defineProperty(window, "visualViewport", { configurable: true, value: visual });
    (window as any).setQueueViewport = (height: number, offsetTop = 0) => { Object.assign(visual, { height, offsetTop }); visual.dispatchEvent(new Event("resize")); visual.dispatchEvent(new Event("scroll")); };
  });
  for (const page of [desktop, phone]) {
    page.on("pageerror", error => errors.push(error.message));
    if (process.env.TAROBOT_QUEUE_LEGACY_SIGNALS === "1") await page.addInitScript(() => { Object.defineProperty(AbortSignal, "any", { value: undefined, configurable: true }); });
  }
  let gateway: GatewayChannel | undefined, release: (() => void) | undefined;
  try {
    const secret = randomBytes(32).toString("base64url");
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash,engine) VALUES('alpha','Claude 助手',?,'claude')", [hashSecret(secret)]);
    const otherChat = await hub.store.createConversation("owner", ["alpha"], "另一独立对话", "other_chat");
    const chat = await hub.store.createConversation("owner", ["alpha"], "待执行顺序", "create");
    gateway = await attachGateway({ stateDir, url: hub.instanceUrl.replace("http", "ws") + "/instance", secret, botId: "alpha", engine: "claude", runtime: createCoreServiceRuntime(), bridge: {
      supportsSteering: () => false,
      handleAuthorizedMessage: async input => {
        calls.push(input.text);
        if (calls.length === 1) { await input.onEngineEvent?.({ type: "assistant_text", text: "第一项正在执行" }); await new Promise<void>(resolve => { release = resolve; input.abortSignal?.addEventListener("abort", resolve, { once: true }); }); }
        return { text: "本项完成" };
      },
    } });
    for (const page of [desktop, phone]) await pair(page, hub, chat.title);
    await phone.evaluate(() => { document.documentElement.style.setProperty("--safe-area-inset-top", "30px"); document.documentElement.style.setProperty("--safe-area-inset-bottom", "18px"); });
    const composer = (page: Page) => page.getByRole("textbox", { name: "消息", exact: true });
    const send = async (text: string) => { await composer(desktop).fill(text); await desktop.getByRole("button", { name: "发送消息", exact: true }).click(); };
    const open = async (page: Page) => { await page.getByRole("button", { name: /管理待执行消息，共/ }).click(); };
    const panel = (page: Page) => page.getByRole("dialog", { name: "待执行消息", exact: true });
    const queuedTexts = (page: Page) => panel(page).locator(".prompt-queue-item:not(.is-locked) .prompt-queue-text");
    await send("第一项先保持运行"); await expect.poll(() => calls.length).toBe(1);
    await expect(desktop.locator(".composer-steer")).toHaveCount(0);
    await send(secondPrompt);
    await expect(desktop.getByRole("button", { name: "管理待执行消息，共 1 条", exact: true })).toBeVisible();
    await expect(composer(desktop)).toHaveValue("");
    await desktop.locator('input[type="file"][multiple]').setInputFiles({ name: "queue-context.txt", mimeType: "text/plain", buffer: Buffer.from("Preserve this attachment") });
    await expect(desktop.getByRole("region", { name: "待发送的附件", exact: true })).toContainText("queue-context.txt");
    await send("第三项附带文件");
    for (const page of [desktop, phone]) await expect(page.getByRole("button", { name: "管理待执行消息，共 2 条", exact: true })).toBeVisible();
    // Existing App identity/message creation still uses UUIDs. Remove it only
    // after initialization so every new queue operation proves its own fallback.
    if (process.env.TAROBOT_QUEUE_LEGACY_SIGNALS === "1") for (const page of [desktop, phone]) await page.evaluate(() => { Object.defineProperty(crypto, "randomUUID", { value: undefined, configurable: true }); });
    // A truly older host advertises no capability, even if the new endpoint
    // would happen to be reachable. The client must not probe or show it.
    const legacyContext = await browser.newContext({ viewport: { width: 1360, height: 900 } });
    try {
      const legacy = await legacyContext.newPage(); let queueReads = 0;
      legacy.on("request", request => { if (request.url().includes(`/api/conversations/${chat.id}/queue`)) queueReads++; });
      await legacy.routeWebSocket("**/ws", socket => { const upstream = socket.connectToServer(); upstream.onMessage(data => { const frame = JSON.parse(String(data)); if (frame.type === "ready") frame.serverCapabilities = frame.serverCapabilities.filter((cap: string) => cap !== "prompt-queue.v1"); socket.send(JSON.stringify(frame)); }); });
      await pair(legacy, hub, chat.title);
      await expect(legacy.getByRole("textbox", { name: "消息", exact: true })).toBeVisible();
      await expect(legacy.getByRole("button", { name: /管理待执行消息，共/ })).toHaveCount(0); expect(queueReads).toBe(0);
    } finally { await legacyContext.close(); }
    // A worker without the verified capability also hides the entry while its
    // existing queue remains intact. Restoring support makes it usable again.
    await hub.store.db.run("UPDATE prompt_queue_workers SET supported=0 WHERE bot_id='alpha'");
    for (const page of [desktop, phone]) await expect(page.getByRole("button", { name: /管理待执行消息，共/ })).toHaveCount(0);
    await hub.store.db.run("UPDATE prompt_queue_workers SET supported=1 WHERE bot_id='alpha'");
    for (const page of [desktop, phone]) await expect(page.getByRole("button", { name: "管理待执行消息，共 2 条", exact: true })).toBeVisible();
    await composer(desktop).fill("桌面输入草稿不受影响"); await composer(phone).fill("手机输入草稿不受影响");
    await phone.getByRole("button", { name: "更多聊天操作", exact: true }).click();
    await expect(phone.getByRole("button", { name: "引导当前任务", exact: true })).toHaveCount(0);
    await phone.getByRole("button", { name: "关闭聊天操作", exact: true }).click();
    for (const page of [desktop, phone]) await open(page);
    await expect(panel(phone).getByText("第一项先保持运行", { exact: true })).toHaveCount(0);
    expect((await panel(phone).boundingBox())!.height).toBeGreaterThanOrEqual(840);
    expect((await panel(phone).locator("header").boundingBox())!.y).toBeGreaterThanOrEqual(30);
    await expect(queuedTexts(phone)).toHaveText([secondPrompt, "第三项附带文件"]);
    await phone.setViewportSize({ width: 320, height: 700 }); await phone.evaluate(() => (window as any).setQueueViewport(700));
    const longRow = panel(phone).locator(".prompt-queue-item").filter({ hasText: secondPrompt });
    await expect(longRow.getByRole("button", { name: "查看全文", exact: true })).toBeVisible();
    const clippedHeight = (await longRow.locator(".prompt-queue-text").boundingBox())!.height;
    await longRow.getByRole("button", { name: "查看全文", exact: true }).click();
    expect((await longRow.locator(".prompt-queue-text").boundingBox())!.height).toBeGreaterThan(clippedHeight);
    await longRow.getByRole("button", { name: "收起全文", exact: true }).click();
    expect((await longRow.getByRole("button", { name: "查看全文", exact: true }).boundingBox())!.height).toBeGreaterThanOrEqual(44);
    expect((await panel(phone).getByRole("button", { name: "刷新待执行消息", exact: true }).boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await phone.setViewportSize({ width: 390, height: 844 }); await phone.evaluate(() => (window as any).setQueueViewport(844));
    await panel(phone).getByRole("button", { name: "上移第 2 条消息", exact: true }).click();
    for (const page of [desktop, phone]) await expect(queuedTexts(page)).toHaveText(["第三项附带文件", secondPrompt]);
    // Real drag in both directions: upper half inserts before, lower half
    // inserts after (including the end). No button fallback in these checks.
    const queueRows = panel(desktop).locator(".prompt-queue-item:not(.is-locked)");
    await panel(desktop).getByRole("button", { name: "拖动调整第 1 条消息", exact: true }).dragTo(queueRows.last(), { targetPosition: { x: 80, y: (await queueRows.last().boundingBox())!.height - 4 } });
    for (const page of [desktop, phone]) await expect(queuedTexts(page)).toHaveText([secondPrompt, "第三项附带文件"]);
    await panel(desktop).getByRole("button", { name: "拖动调整第 2 条消息", exact: true }).dragTo(queueRows.first(), { targetPosition: { x: 80, y: 4 } });
    for (const page of [desktop, phone]) await expect(queuedTexts(page)).toHaveText(["第三项附带文件", secondPrompt]);
    for (const page of [desktop, phone]) await expect(queuedTexts(page)).toHaveText(["第三项附带文件", secondPrompt]);
    expect(calls).toHaveLength(1);
    // Lose one response AFTER the host committed the move. The retry must use
    // the same request ID/body and must not apply the move twice.
    const bodies: string[] = [];
    let loseResponse = true, rejectReceiptCheck = true;
    await desktop.route(`**/api/conversations/${chat.id}/queue`, async route => {
      if (route.request().method() !== "POST") { await route.continue(); return; }
      bodies.push(route.request().postData()!);
      if (loseResponse) { loseResponse = false; await route.fetch(); await route.abort("connectionfailed"); }
      // A transient authentication rejection on the RETRY says nothing about
      // the first request, which the host has already committed.
      else if (rejectReceiptCheck) { rejectReceiptCheck = false; await route.fulfill({ status: 401, contentType: "application/json", body: JSON.stringify({ error: "session_expired" }) }); }
      else await route.continue();
    });
    await panel(desktop).getByRole("button", { name: "下移第 1 条消息", exact: true }).click();
    await expect(panel(desktop).getByRole("button", { name: "重试并核对结果", exact: true })).toBeVisible();
    await expect(panel(desktop).getByRole("button", { name: "编辑第 1 条消息", exact: true })).toBeDisabled();
    await hub.store.db.run("UPDATE prompt_queue_workers SET supported=0 WHERE bot_id='alpha'");
    await expect(panel(desktop)).toContainText("此 Bot 当前不支持管理待执行消息。");
    await panel(desktop).getByRole("button", { name: "关闭待执行消息", exact: true }).click();
    await selectConversation(desktop, otherChat.title);
    await expect(desktop.getByRole("button", { name: /管理待执行消息，共/ })).toHaveCount(0);
    await expect(desktop.getByRole("button", { name: "重试并核对结果", exact: true })).toHaveCount(0);
    await selectConversation(desktop, chat.title);
    await open(desktop);
    await expect(panel(desktop).getByRole("button", { name: "重试并核对结果", exact: true })).toBeVisible();
    await panel(desktop).getByRole("button", { name: "重试并核对结果", exact: true }).click();
    await expect(panel(desktop).getByRole("button", { name: "重试并核对结果", exact: true })).toBeEnabled();
    await expect(panel(desktop).locator(".prompt-queue-actions button")).toHaveCount(0);
    await panel(desktop).getByRole("button", { name: "重试并核对结果", exact: true }).click();
    await expect(panel(desktop).getByRole("button", { name: "重试并核对结果", exact: true })).toHaveCount(0);
    expect(bodies).toHaveLength(3); expect(new Set(bodies).size).toBe(1);
    await desktop.unroute(`**/api/conversations/${chat.id}/queue`);
    await hub.store.db.run("UPDATE prompt_queue_workers SET supported=1 WHERE bot_id='alpha'");
    for (const page of [desktop, phone]) await expect(queuedTexts(page)).toHaveText([secondPrompt, "第三项附带文件"]);
    // Definitive host errors must explain the cause instead of implying that
    // clicking the same reorder again would fix an archived/unsupported queue.
    for (const [code, copy] of [["queue_control_barrier", "不能跨过控制命令"], ["conversation_archived", "对话已归档"], ["worker_update_required", "请更新主机"], ["idempotency_conflict", "操作编号与主机记录冲突"], ["queue_already_dispatched", "不能再调整这条消息"]]) {
      await desktop.route(`**/api/conversations/${chat.id}/queue`, async route => { if (route.request().method() === "POST") await route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ error: code }) }); else await route.continue(); });
      await panel(desktop).getByRole("button", { name: "下移第 1 条消息", exact: true }).click();
      await expect(panel(desktop).getByRole("alert")).toContainText(copy);
      await desktop.unroute(`**/api/conversations/${chat.id}/queue`);
    }
    // Force a real compare-and-swap rejection, then verify the edit survives
    // refresh and closing/reopening the page, while the composer is untouched.
    await panel(phone).getByRole("button", { name: "编辑第 2 条消息", exact: true }).click();
    await panel(phone).getByRole("textbox", { name: "编辑待执行消息", exact: true }).fill("第三项修改后附带文件");
    // Simulate the phone keyboard's viewport signals, not a physical keyboard.
    await phone.evaluate(() => (window as any).setQueueViewport(500, 24));
    const save = panel(phone).getByRole("button", { name: "保存修改", exact: true });
    await save.scrollIntoViewIfNeeded();
    await expect.poll(async () => { const bounds = (await save.boundingBox())!; return bounds.y >= 24 && bounds.y + bounds.height <= 524; }).toBe(true);
    expect((await panel(phone).locator("header").boundingBox())!.y).toBeGreaterThanOrEqual(24);
    await expect.poll(() => panel(phone).locator(".prompt-queue-list").evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true);
    await panel(phone).locator(".prompt-queue-list").evaluate(element => { element.scrollTop = element.scrollHeight; });
    await expect.poll(() => panel(phone).locator(".prompt-queue-list").evaluate(element => element.scrollTop)).toBeGreaterThan(0);
    await pageScreenshot();
    async function pageScreenshot() { await phone.screenshot({ path: info.outputPath("queue-keyboard.png"), clip: { x: 0, y: 24, width: 390, height: 500 } }); }
    // Landscape plus an open keyboard can leave only 220 px for the page.
    await phone.setViewportSize({ width: 844, height: 390 });
    await phone.evaluate(() => { (window as any).setQueueViewport(220); const style = document.documentElement.style; style.setProperty("--safe-area-inset-top", "0px"); style.setProperty("--safe-area-inset-left", "47px"); style.setProperty("--safe-area-inset-right", "47px"); style.setProperty("--safe-area-inset-bottom", "21px"); });
    const landscapeEditor = panel(phone).getByRole("textbox", { name: "编辑待执行消息", exact: true });
    await landscapeEditor.scrollIntoViewIfNeeded();
    await landscapeEditor.fill("第三项修改后附带文件");
    const editorBounds = (await landscapeEditor.boundingBox())!;
    expect(editorBounds.y).toBeGreaterThanOrEqual(44); expect(editorBounds.y + editorBounds.height).toBeLessThanOrEqual(220);
    expect(await panel(phone).evaluate(element => getComputedStyle(element).overflowY)).toBe("auto");
    await save.scrollIntoViewIfNeeded();
    await phone.screenshot({ path: info.outputPath("queue-landscape-keyboard.png"), clip: { x: 0, y: 0, width: 844, height: 220 } });
    const landscapeSave = (await save.boundingBox())!;
    expect(landscapeSave.y).toBeGreaterThanOrEqual(0); expect(landscapeSave.y + landscapeSave.height).toBeLessThanOrEqual(199);
    const landscapeClose = (await panel(phone).getByRole("button", { name: "关闭待执行消息", exact: true }).boundingBox())!;
    expect(landscapeClose.y).toBeGreaterThanOrEqual(0); expect(landscapeClose.y + landscapeClose.height).toBeLessThanOrEqual(199);
    const pinnedHeader = (await panel(phone).locator("header").boundingBox())!;
    expect(pinnedHeader.y).toBe(0); expect(pinnedHeader.x).toBe(0); expect(pinnedHeader.width).toBe(844);
    expect(await phone.evaluate(() => !!document.elementFromPoint(1, 1)?.closest(".prompt-queue-panel>header"))).toBe(true);
    await save.click();
    await expect(landscapeEditor).toHaveCount(0);
    await expect(queuedTexts(phone)).toHaveText([secondPrompt, "第三项修改后附带文件"]);
    await phone.setViewportSize({ width: 390, height: 844 });
    await phone.evaluate(() => { (window as any).setQueueViewport(844); const style = document.documentElement.style; style.setProperty("--safe-area-inset-top", "30px"); style.setProperty("--safe-area-inset-left", "0px"); style.setProperty("--safe-area-inset-right", "0px"); style.setProperty("--safe-area-inset-bottom", "18px"); });
    await panel(phone).getByRole("button", { name: "编辑第 2 条消息", exact: true }).click();
    await panel(phone).getByRole("textbox", { name: "编辑待执行消息", exact: true }).fill("/new");
    await panel(phone).getByRole("button", { name: "保存修改", exact: true }).click();
    await expect(panel(phone).getByRole("alert")).toContainText("待执行消息不能改成控制命令");
    await panel(phone).getByRole("textbox", { name: "编辑待执行消息", exact: true }).fill("第三项修改后附带文件");
    // Another device edits the SAME message while the phone is editing. Even
    // after polling fetches that new version, save must reject the old baseline.
    await panel(desktop).getByRole("button", { name: "编辑第 2 条消息", exact: true }).click();
    await panel(desktop).getByRole("textbox", { name: "编辑待执行消息", exact: true }).fill("第三项由桌面修订");
    await panel(desktop).getByRole("button", { name: "保存修改", exact: true }).click();
    await expect(queuedTexts(phone)).toHaveText([secondPrompt, "第三项由桌面修订"]);
    await panel(phone).getByRole("button", { name: "保存修改", exact: true }).click();
    await expect(panel(phone).getByRole("alert")).toContainText("队列已变化");
    await expect(panel(phone).getByRole("textbox", { name: "编辑待执行消息", exact: true })).toHaveValue("第三项修改后附带文件");
    await panel(phone).getByRole("button", { name: "关闭待执行消息", exact: true }).click();
    await expect(composer(phone)).toHaveValue("手机输入草稿不受影响");
    await open(phone);
    await expect(panel(phone).getByRole("textbox", { name: "编辑待执行消息", exact: true })).toHaveValue("第三项修改后附带文件");
    await expect(panel(phone)).toContainText("上方是主机当前保存的内容");
    await panel(phone).getByRole("button", { name: "核对后保存我的修改", exact: true }).click();
    for (const page of [desktop, phone]) { await expect(queuedTexts(page)).toHaveText([secondPrompt, "第三项修改后附带文件"]); await expect(panel(page).locator(".prompt-queue-item").filter({ hasText: "第三项修改后附带文件" })).toContainText("1 个附件"); }
    const editedId = await panel(phone).locator(".prompt-queue-item").filter({ hasText: "第三项修改后附带文件" }).getAttribute("data-queue-message-id");
    expect((await hub.store.messageForUser("owner", editedId!)).blocks.some(block => block.type === "file")).toBe(true);
    for (const [page, kind] of [[desktop, "desktop"], [phone, "phone"]] as const) { await page.screenshot({ path: info.outputPath(`queue-${kind}.png`) }); expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(page.viewportSize()!.width); }
    // A touch phone can be wider than the desktop breakpoint in landscape.
    await phone.setViewportSize({ width: 844, height: 390 });
    await phone.evaluate(() => { (window as any).setQueueViewport(390); const style = document.documentElement.style; style.setProperty("--safe-area-inset-top", "0px"); style.setProperty("--safe-area-inset-left", "47px"); style.setProperty("--safe-area-inset-right", "47px"); style.setProperty("--safe-area-inset-bottom", "21px"); });
    await expect.poll(async () => (await panel(phone).boundingBox())!.width).toBe(844);
    const closeBounds = (await panel(phone).getByRole("button", { name: "关闭待执行消息", exact: true }).boundingBox())!;
    expect(closeBounds.x).toBeGreaterThanOrEqual(47); expect(closeBounds.x + closeBounds.width).toBeLessThanOrEqual(797); expect(closeBounds.height).toBeGreaterThanOrEqual(44);
    await panel(phone).getByRole("button", { name: "取消第 1 条待执行消息", exact: true }).click();
    const confirm = panel(phone).getByRole("button", { name: "确认取消排队", exact: true }); await confirm.scrollIntoViewIfNeeded();
    const confirmBounds = (await confirm.boundingBox())!; expect(confirmBounds.y + confirmBounds.height).toBeLessThanOrEqual(369); expect(confirmBounds.height).toBeGreaterThanOrEqual(44);
    await phone.screenshot({ path: info.outputPath("queue-landscape.png") });
    await panel(phone).getByRole("button", { name: "保留", exact: true }).click();
    await phone.setViewportSize({ width: 390, height: 844 });
    await phone.evaluate(() => { (window as any).setQueueViewport(844); const style = document.documentElement.style; style.setProperty("--safe-area-inset-top", "30px"); style.setProperty("--safe-area-inset-left", "0px"); style.setProperty("--safe-area-inset-right", "0px"); style.setProperty("--safe-area-inset-bottom", "18px"); });
    await panel(desktop).getByRole("button", { name: "取消第 1 条待执行消息", exact: true }).click();
    await panel(desktop).getByRole("button", { name: "确认取消排队", exact: true }).click();
    for (const page of [desktop, phone]) await expect(queuedTexts(page)).toHaveText(["第三项修改后附带文件"]);
    expect(calls).toHaveLength(1);
    await panel(desktop).getByRole("button", { name: "关闭待执行消息", exact: true }).click();
    await expect(desktop.locator(".message.user").filter({ hasText: secondPrompt })).toContainText("已取消排队，未发送给 Bot。");
    await expect(desktop.locator(".message.user").filter({ hasText: secondPrompt }).locator(".rich-card")).toHaveCount(0);
    await panel(phone).getByRole("button", { name: "编辑第 1 条消息", exact: true }).click();
    await panel(phone).getByRole("textbox", { name: "编辑待执行消息", exact: true }).fill("编辑期间已经下发，保留我的文字");
    await expect(composer(desktop)).toHaveValue("桌面输入草稿不受影响");
    const history = await hub.store.db.all<{ id: string }>("SELECT id FROM messages WHERE conversation_id=? AND author_type='user' ORDER BY created_at,rowid", [chat.id]);
    expect(await Promise.all(history.map(async row => blocksText((await hub.store.messageForUser("owner", row.id)).blocks.filter(block => block.type === "text"))))).toEqual(["第一项先保持运行", secondPrompt, "第三项修改后附带文件"]);
    release?.(); await expect.poll(() => calls.length).toBe(2); expect(calls[1]).toContain("第三项修改后附带文件"); expect(calls.join("\n")).not.toContain(secondPrompt);
    await expect(panel(phone).getByRole("textbox", { name: "编辑待执行消息", exact: true })).toHaveValue("编辑期间已经下发，保留我的文字");
    await expect(panel(phone).getByRole("button", { name: "保存修改", exact: true })).toBeDisabled();
    await expect(panel(phone)).toContainText("这条消息已下发或不再可编辑");
    await expect(panel(phone).getByRole("button", { name: "复制文字", exact: true })).toBeEnabled();
    await panel(phone).getByRole("button", { name: "放弃编辑", exact: true }).click();
    await panel(phone).getByRole("button", { name: "关闭待执行消息", exact: true }).click();
    for (const page of [desktop, phone]) await expect(page.getByRole("button", { name: /管理待执行消息，共/ })).toHaveCount(0);
    expect(errors).toEqual([]);
  } finally { release?.(); await gateway?.disconnect(); await desktopContext.close(); await phoneContext.close(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});


test("an edit losing the head claim preserves text without offering a conflicting save", async ({ page }) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "queue-edit-claim-"));
  const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve("dist") });
  try {
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash,engine,online) VALUES('alpha','测试助手','fixture','claude',1)");
    const queue = new HubPromptQueue(hub.store); await queue.registerWorker("alpha", true);
    const chat = await hub.store.createConversation("owner", ["alpha"], "编辑争用", "create");
    const message = (await hub.store.sendMessage("owner", { conversationId: chat.id, clientMsgId: "pending", text: "原内容", attachments: [] })).message;
    await pair(page, hub, chat.title);
    await page.getByRole("button", { name: "管理待执行消息，共 1 条", exact: true }).click();
    const panel = page.getByRole("dialog", { name: "待执行消息", exact: true });
    await panel.getByRole("button", { name: "编辑第 1 条消息", exact: true }).click();
    const editor = panel.getByRole("textbox", { name: "编辑待执行消息", exact: true });
    await editor.fill("应保留的修改");
    await page.route("**/api/conversations/*/queue", async route => {
      if (route.request().method() === "POST") expect((await queue.take("alpha", chat.id, () => true))?.id).toBe(message.id);
      await route.continue();
    });
    await panel.getByRole("button", { name: "保存修改", exact: true }).click();
    await expect(panel.getByRole("alert")).toContainText("这条消息已交给 Bot");
    await expect(editor).toHaveValue("应保留的修改");
    await expect(panel.locator(".prompt-queue-edit-conflict")).toHaveCount(0);
    await expect(panel.getByRole("button", { name: "保存修改", exact: true })).toBeDisabled();
    expect(blocksText((await hub.store.messageForUser("owner", message.id)).blocks)).toBe("原内容");
  } finally { await page.close(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});
