import { test, expect, type Page } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HubServer } from "../../src/hub/server.js";
import type { WorkbenchActor, WorkbenchBroker } from "../../src/hub/workbench.js";
import type { WorkbenchRequest, WorkbenchTarget } from "../../src/client-protocol/workbench.js";
import { openSettings, closeSettings } from "./fixtures/settings.js";
import { preparePairing } from "./fixtures/pairing-invite.js";
import { selectConversation, showDisconnectedBots, waitForClientOnline } from "./fixtures/mobile.js";

test.use({ serviceWorkers: "block" });
const panel = (page: Page) => page.getByRole("complementary", { name: "工作台", exact: true });
const renderedTitle = (page: Page) => page.frameLocator(".workbench-design-frame:visible").frameLocator("iframe").locator("h1");
async function fixture(page: Page) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "design-auto-open-"));
  const hub = await HubServer.start({ stateDir: directory, clientDir: path.resolve("dist") });
  await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','设计助手','fixture')");
  const a = await hub.store.createConversation("owner", ["alpha"], "设计请求 A", "open_a");
  const b = await hub.store.createConversation("owner", ["alpha"], "另一个对话 B", "open_b");
  for (const conversation of [a, b]) await hub.store.publishBotMessage("alpha", { conversationId: conversation.id, status: "complete", blocks: [{ type: "text", text: conversation.title }] });
  await page.goto(hub.url); await preparePairing(page, hub); await page.getByRole("button", { name: "配对此设备", exact: true }).click();
  await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
  await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" });
  await waitForClientOnline(page); await showDisconnectedBots(page); await selectConversation(page, a.title);
  const broker = (hub as unknown as { workbench: WorkbenchBroker }).workbench;
  const actor = (conversationId = a.id): WorkbenchActor => ({ userId: "owner", conversationId, validate: async () => undefined });
  const windows = (conversationId = a.id) => broker.list(actor(conversationId));
  const opener = async () => (await windows()).find(window => window.capabilities.includes("design.open.v1"));
  await expect.poll(opener).toBeTruthy();
  async function source(p = page, conversation = a, text = "请明确用 Design 做这个页面") {
    const previous = await hub.store.db.all<{ id: string }>("SELECT id FROM messages WHERE author_type='user' AND conversation_id=?", [conversation.id]);
    await p.getByRole("textbox", { name: "消息", exact: true }).fill(text);
    await p.getByRole("button", { name: "发送消息", exact: true }).click();
    const latest = async () => (await hub.store.db.all<{ id: string }>("SELECT id FROM messages WHERE author_type='user' AND conversation_id=?", [conversation.id])).find(row => !previous.some(old => old.id === row.id));
    await expect.poll(latest).toBeTruthy();
    const sourceMessageId = (await latest())!.id;
    const context = await broker.contextForMessage("owner", sourceMessageId, conversation.id);
    expect(context?.openTarget).toBeTruthy();
    return { ...actor(conversation.id), sourceMessageId, context };
  }
  const command = (source: WorkbenchActor, requestId: string, target?: WorkbenchTarget) => broker.request(source, { requestId, operation: "design.open", target, payload: {} });
  return { hub, a, b, broker, actor, windows, opener, source, command,
    close: async () => { for (const p of page.context().pages()) await p.close({ runBeforeUnload: false }); await hub.close(); await rm(directory, { recursive: true, force: true }); } };
}

for (const phone of [false, true]) test(`explicit Design command opens the closed ${phone ? "phone" : "desktop"} workbench and reuses the saved design`, async ({ page }, info) => {
  test.setTimeout(90000); if (phone) await page.setViewportSize({ width: 390, height: 844 });
  const loaded: string[] = []; page.on("request", request => loaded.push(request.url()));
  const f = await fixture(page);
  try {
    await expect(panel(page)).toHaveCount(0);
    expect(loaded.filter(url => /\/(?:workbench-controller|WorkbenchDesign|WorkbenchCanvas|WorkbenchMarkdown)[-.]/.test(url))).toEqual([]);
    const source = await f.source();
    // Sending a Design request alone does not guess from keywords or open UI.
    await expect(panel(page)).toHaveCount(0);
    const receipt = await f.command(source, "open-from-user");
    expect(receipt).toMatchObject({ status: "applied", saved: true, result: { created: true } });
    const target = (receipt.result as { target: WorkbenchTarget }).target;
    await expect(panel(page)).toBeVisible();
    await expect(page.frameLocator(".workbench-design-frame:visible").getByText("画布", { exact: true }).first()).toBeVisible({ timeout: 20000 });
    await expect(renderedTitle(page)).toHaveText("画布", { timeout: 20000 });
    const read: WorkbenchRequest = { requestId: "read-opened", operation: "design.read", target, payload: { path: "project/Main.dc.html" } };
    const content = await f.broker.request(source, read);
    const html = (content.result as { content: string }).content.replace("画布", "Automatically opened Design");
    const published = await f.broker.request(source, { requestId: "publish-opened", operation: "design.publish", target, expectedRevision: content.revision, payload: { files: { "project/Main.dc.html": { content: html, contentType: "text/html" } } } });
    expect(published).toMatchObject({ status: "applied", saved: true });
    await expect(renderedTitle(page)).toHaveText("Automatically opened Design", { timeout: 15000 });
    expect(await f.command(source, "open-from-user")).toEqual(receipt);
    const repeat = await f.command(source, "open-existing");
    expect(repeat).toMatchObject({ status: "applied", result: { target, created: false } });
    const realWindows = (await f.windows()).filter(window => !window.capabilities.includes("design.open.v1"));
    expect(realWindows).toHaveLength(1); expect(realWindows[0].tabs.filter(tab => tab.kind === "design")).toHaveLength(1);
    await page.screenshot({ path: info.outputPath(phone ? "design-auto-phone.png" : "design-auto-desktop.png") });
    await panel(page).getByRole("button", { name: "返回聊天", exact: true }).click();
    await expect(panel(page)).toBeHidden();
    await expect.poll(async () => (await f.opener())?.windowId).not.toBe(source.context!.openTarget!.windowId);
    await expect(f.command(source, "old-turn-after-close")).rejects.toThrow(/workbench_(open_target|app)_unavailable/);
    await expect(panel(page)).toBeHidden();
    const fresh = await f.source(page, f.a, "再用 Design 继续这个设计");
    expect(await f.command(fresh, "fresh-reopen")).toMatchObject({ status: "applied", result: { target, created: false } });
    await expect(renderedTitle(page)).toHaveText("Automatically opened Design", { timeout: 15000 });
  } finally { await f.close(); }
});

test("a queued open cannot follow navigation, and a source never targets another App window", async ({ page }) => {
  test.setTimeout(90000); const f = await fixture(page);
  let release = () => {}; const original = f.broker.admit.bind(f.broker);
  try {
    const source = await f.source();
    const other = await page.context().newPage(); await other.goto(f.hub.url); await waitForClientOnline(other); await selectConversation(other, f.a.title);
    await expect.poll(async () => (await f.windows()).filter(window => window.capabilities.includes("design.open.v1")).length).toBe(2);
    const foreign = (await f.windows()).find(window => window.windowId !== source.context!.openTarget!.windowId)!;
    await expect(f.command(source, "wrong-window", { deviceId: foreign.deviceId, windowId: foreign.windowId })).rejects.toThrow("workbench_open_target_mismatch");
    let entered!: () => void; const started = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    f.broker.admit = async (peer, id) => { entered(); await gate; return original(peer, id); };
    const pending = f.command(source, "navigate-during-admit");
    await started; await selectConversation(page, f.b.title); release();
    const receipt = await pending; expect(receipt.status).not.toBe("applied");
    await expect(panel(page)).toHaveCount(0); await expect(panel(other)).toHaveCount(0);
    f.broker.admit = original;
    const next = await f.source(page, f.b, "用 Design 做 B 的设计");
    const opened = await f.command(next, "only-b");
    expect(opened).toMatchObject({ status: "applied", saved: true });
    await expect(panel(page)).toBeVisible();
    await expect(panel(page).getByRole("tab", { name: "画布", exact: true })).toHaveAttribute("aria-selected", "true");
    // This case tests window/navigation routing; preview render and publish
    // are covered by both desktop/phone journeys above. The legacy multi-window
    // inner-preview timeout also reproduces on unchanged base (see audit doc).
    const content = await f.broker.request(next, { requestId: "read-only-b", operation: "design.read", target: (opened.result as { target: WorkbenchTarget }).target, payload: { path: "project/Main.dc.html" } });
    expect(content).toMatchObject({ status: "success", result: { content: expect.stringContaining("设计") } });
    await expect(panel(other)).toHaveCount(0);
  } finally { release(); f.broker.admit = original; await f.close(); }
});


test("opening App settings retires the old Design request without disturbing the settings page", async ({ page }) => {
  test.setTimeout(90000); const f = await fixture(page);
  try {
    const source = await f.source();
    await openSettings(page, "general");
    await expect.poll(async () => (await f.windows()).some(window => window.windowId === source.context!.openTarget!.windowId)).toBe(false);
    await expect(f.command(source, "settings-must-stay")).rejects.toThrow("workbench_open_target_unavailable");
    await expect(page.getByRole("button", { name: "关闭设置", exact: true })).toBeVisible();
    await expect(panel(page)).toHaveCount(0);
    await closeSettings(page);
    await expect.poll(f.opener).toBeTruthy();
    await expect(f.command(source, "old-request-after-settings")).rejects.toThrow("workbench_open_target_unavailable");
    const fresh = await f.source(page, f.a, "现在用 Design");
    expect(await f.command(fresh, "fresh-after-settings")).toMatchObject({ status: "applied", saved: true });
    await expect(panel(page)).toBeVisible();
  } finally { await f.close(); }
});

test("retiring an optional Design opener during message capture never fails ordinary chat", async ({ page }) => {
  test.setTimeout(90000);
  let release = () => {};
  let entered!: () => void, hold = true;
  const paused = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  // Hold only the user message, after the App froze its metadata. The opener's
  // later unregister must reach the real Host before that message does.
  await page.routeWebSocket(/\/ws$/, socket => {
    const server = socket.connectToServer();
    socket.onMessage(message => {
      if (hold && typeof message === "string" && JSON.parse(message).type === "message.send") {
        hold = false; entered(); void gate.then(() => server.send(message)).catch(() => {});
      } else server.send(message);
    });
  });
  const f = await fixture(page);
  try {
    const original = (await f.opener())!;
    await page.getByRole("textbox", { name: "消息", exact: true }).fill("普通聊天不能被可选的设计入口挡住");
    await page.getByRole("button", { name: "发送消息", exact: true }).click();
    await paused;
    await openSettings(page, "general");
    await expect.poll(async () => (await f.windows()).some(window => window.windowId === original.windowId)).toBe(false);
    release();
    const sent = () => f.hub.store.db.all<{ id: string }>("SELECT id FROM messages WHERE author_type='user' AND conversation_id=?", [f.a.id]);
    await expect.poll(async () => (await sent()).length, { timeout: 15000 }).toBe(1);
    const sourceMessageId = (await sent())[0].id;
    const context = await f.broker.contextForMessage("owner", sourceMessageId, f.a.id);
    expect(context?.openTarget?.windowId).toBe(original.windowId);
    await expect(f.command({ ...f.actor(), sourceMessageId, context }, "retired-during-chat-send")).rejects.toThrow("workbench_open_target_unavailable");
    await expect(page.getByRole("button", { name: "关闭设置", exact: true })).toBeVisible();
    await expect(panel(page)).toHaveCount(0);
  } finally { release(); await f.close(); }
});

test("ADHD never auto-opens Design, retires old requests and keeps manual Design usable", async ({ page }) => {
  test.setTimeout(90000);
  const f = await fixture(page);
  try {
    await f.hub.profile.update({ name: "测试主机", revision: (await f.hub.profile.read()).revision });
    const old = await f.source();
    await page.getByRole("button", { name: "打开 ADHD 模式", exact: true }).click();
    for (const conversation of [f.a, f.b]) {
      await page.getByRole("checkbox", { name: `加入面板：测试主机 · ${conversation.title}`, exact: true }).check();
    }
    const card = page.locator(`.adhd-card[data-pane-conversation="${f.a.id}"]`);
    const other = page.locator(`.adhd-card[data-pane-conversation="${f.b.id}"]`);
    await expect(card.locator(".composer textarea")).toBeVisible();
    await expect(other).toBeVisible();
    await expect.poll(f.opener).toBeUndefined();
    await expect.poll(async () => (await f.windows(f.b.id)).some(window => window.capabilities.includes("design.open.v1"))).toBe(false);
    await expect(f.command(old, "old-open-after-adhd")).rejects.toThrow("workbench_open_target_unavailable");

    // Explicit Design text still sends normally, but carries no automatic opener.
    const previous = await f.hub.store.db.all<{ id: string }>("SELECT id FROM messages WHERE author_type='user' AND conversation_id=?", [f.a.id]);
    await card.locator(".composer textarea").fill("在 ADHD 里用 Design，但不要自动展开工作台");
    await card.locator(".send-button").click();
    const latest = async () => (await f.hub.store.db.all<{ id: string }>("SELECT id FROM messages WHERE author_type='user' AND conversation_id=?", [f.a.id])).find(row => !previous.some(old => old.id === row.id));
    await expect.poll(latest).toBeTruthy();
    const sourceMessageId = (await latest())!.id;
    const context = await f.broker.contextForMessage("owner", sourceMessageId, f.a.id);
    expect(context?.openTarget).toBeUndefined();
    await expect(f.command({ ...f.actor(), sourceMessageId, context }, "adhd-open-is-disabled")).rejects.toThrow("workbench_open_target_required");
    await expect(card).not.toHaveClass(/is-expanded/);
    await expect(other).toBeVisible();
    await expect(panel(page)).toHaveCount(0);

    // Manual opening is separate, and an expanded ADHD card remains manual-only.
    await card.getByRole("button", { name: "工作台", exact: true }).click();
    await expect(card).toHaveClass(/is-expanded/);
    await panel(page).getByRole("button", { name: "新建内容", exact: true }).click();
    await panel(page).getByRole("menu").getByRole("button", { name: "画布", exact: true }).click();
    await expect(panel(page).getByRole("tab", { name: "画布", exact: true })).toHaveAttribute("aria-selected", "true");
    await expect.poll(async () => (await f.windows()).some(window => window.visible && window.tabs.some(tab => tab.kind === "design"))).toBe(true);
    expect(await f.opener()).toBeUndefined();
    const window = (await f.windows()).find(window => window.visible && window.tabs.some(tab => tab.kind === "design"))!;
    const target = { deviceId: window.deviceId, windowId: window.windowId, tabId: window.tabs.find(tab => tab.kind === "design")!.id };
    const read = await f.broker.request(f.actor(), { requestId: "manual-adhd-design-read", operation: "design.read", target, payload: { path: "project/Main.dc.html" } });
    expect(read).toMatchObject({ status: "success", result: { content: expect.stringContaining("设计") } });

    await card.getByRole("button", { name: "在单对话中打开", exact: true }).click();
    await expect(page.locator(".adhd-shell")).toHaveCount(0);
    await expect.poll(f.opener).toBeTruthy();
    await expect(f.command(old, "old-open-after-return")).rejects.toThrow("workbench_open_target_unavailable");
    const fresh = await f.source(page, f.a, "回到单对话后用 Design 继续");
    expect(await f.command(fresh, "single-chat-open-again")).toMatchObject({ status: "applied", saved: true });
    await expect(panel(page)).toBeVisible();
  } finally { await f.close(); }
});
