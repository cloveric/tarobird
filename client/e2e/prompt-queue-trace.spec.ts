import { preparePairing } from "./fixtures/pairing-invite.js";
import { test, expect, type Page } from "@playwright/test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HubServer } from "../../src/hub/server.js";
import { HubPromptQueue } from "../../src/hub/prompt-queue.js";
import { blocksText } from "../../src/client-protocol/index.js";
import { selectConversation, waitForClientOnline } from "./fixtures/mobile.js";
import { closeSettings, openSettings } from "./fixtures/settings.js";

// One journey rewrites queue reads. WebKit service-worker fetches bypass page.route.
test.use({ serviceWorkers: "block" });

const same = "内容相同的两条待执行消息";

async function upload(hub: HubServer, conversationId: string, name: string, mime: string, bytes: Buffer) {
  const created = await hub.attachments.create("owner", { conversationId, name, mime, size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
  await hub.attachments.putChunk("owner", created.id, 0, bytes); await hub.attachments.complete("owner", created.id);
  return created.id;
}

/** Real queued history: identical text, identical attachment-only previews and a
 * file, followed by filler that pushes the originals out of the chat viewport. */
async function fixture(page: Page, fillers: number) {
  const root = await mkdtemp(path.join(os.tmpdir(), "queue-trace-"));
  const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve("dist") });
  const close = async () => { await page.close(); await hub.close(); await rm(root, { recursive: true, force: true }); };
  const errors: string[] = [], writes: string[] = [], sends: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  // Locating is navigation only: it must never send, edit, reorder or cancel.
  page.on("websocket", socket => socket.on("framesent", frame => { const text = String(frame.payload); if (text.includes('"message.send"')) sends.push(text); }));
  try {
    await hub.profile.update({ name: "原消息测试主机", revision: (await hub.profile.read()).revision });
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash,engine,online) VALUES('alpha','测试助手','fixture','claude',1)");
    const queue = new HubPromptQueue(hub.store); await queue.registerWorker("alpha", true);
    const chat = await hub.store.createConversation("owner", ["alpha"], "原消息定位对话", "trace");
    page.on("request", request => { if (request.method() === "POST" && request.url().includes(`/api/conversations/${chat.id}/queue`)) writes.push(request.postData() ?? ""); });
    const send = async (clientMsgId: string, text: string, attachments: string[] = []) => {
      const id = (await hub.store.sendMessage("owner", { conversationId: chat.id, clientMsgId, text, attachments })).message.id;
      await new Promise(resolve => setTimeout(resolve, 2));
      return id;
    };
    const image = await readFile("src/assets/bot-avatars/hamster.webp");
    const sameIds = [await send("same-0", same), await send("same-1", same)];
    const imageIds = [await send("image-0", "", [await upload(hub, chat.id, "截图.webp", "image/webp", image)])];
    imageIds.push(await send("image-1", "", [await upload(hub, chat.id, "截图.webp", "image/webp", image)]));
    const file = await send("file-0", "", [await upload(hub, chat.id, "队列说明.txt", "text/plain", Buffer.from("queued source attachment"))]);
    const fillerIds: string[] = [];
    for (let i = 0; i < fillers; i++) fillerIds.push(await send(`filler-${i}`, `后续任务 ${i}：` + "保留自己的聊天位置。".repeat(4)));
    await page.goto(hub.url); await preparePairing(page, hub); await page.getByRole("button", { name: "配对此设备", exact: true }).click();
    await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
    await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" });
    await waitForClientOnline(page); await selectConversation(page, chat.title);
    const queued = async () => (await queue.read("owner", "alpha", chat.id)).items.filter(item => item.state === "queued").map(item => item.message.id);
    return {
      hub, queue, chat, errors, writes, sends, close, queued,
      ids: { same: sameIds, image: imageIds, file, fillers: fillerIds },
      row: (id: string) => page.locator(`dialog.prompt-queue-panel [data-queue-message-id="${id}"]`),
      bubble: (id: string) => page.locator(`[data-message-id="${id}"]`).filter({ visible: true }),
      focused: () => page.locator(".message.focused-message").filter({ visible: true }),
    };
  } catch (error) { await close(); throw error; }
}

for (const adhd of [false, true]) test(`visible source buttons locate exact originals, attachments and reordered rows (${adhd ? "ADHD" : "chat"})`, async ({ page }, info) => {
  test.setTimeout(150_000);
  await page.setViewportSize({ width: 1500, height: 900 });
  const f = await fixture(page, 60);
  try {
    if (adhd) {
      await page.getByRole("button", { name: "打开 ADHD 模式", exact: true }).click();
      await page.getByRole("checkbox", { name: `加入面板：原消息测试主机 · ${f.chat.title}`, exact: true }).check();
    }
    const composer = page.locator(".composer textarea").filter({ visible: true }); await composer.fill("未发送的主输入框草稿");
    const panel = page.getByRole("dialog", { name: "待执行消息", exact: true });
    const open = async () => { await page.getByRole("button", { name: /管理待执行消息，共/ }).click(); await expect(panel).toBeVisible(); };
    const source = (id: string) => f.row(id).getByRole("button", { name: /^查看第 \d+ 条原消息$/ });
    const located = async (id: string) => {
      await expect(panel).toHaveCount(0);
      await expect(f.bubble(id)).toHaveClass(/focused-message/); await expect(f.bubble(id)).toBeInViewport();
      await expect(f.focused()).toHaveCount(1);
    };
    await expect(f.bubble(f.ids.same[0]!)).not.toBeInViewport();
    const initial = await f.queue.read("owner", "alpha", f.chat.id);
    await open();
    await expect(panel.locator(".prompt-queue-item").first()).toBeVisible();
    await page.screenshot({ path: info.outputPath(`trace-desktop-${adhd ? "adhd" : "chat"}-panel.png`) });
    // Keep an unsaved queue edit open on an unrelated row. It disables other
    // edits/cancellation, never source location.
    await f.row(f.ids.fillers[0]!).getByRole("button", { name: "编辑第 6 条消息", exact: true }).click();
    const editor = panel.getByRole("textbox", { name: "编辑待执行消息", exact: true }); await editor.fill("未保存的队列修改");
    await expect(panel.getByRole("button", { name: "编辑第 1 条消息", exact: true })).toBeDisabled();
    const second = f.row(f.ids.same[1]!).getByRole("button", { name: "查看第 2 条原消息", exact: true });
    await expect(second).toHaveText(""); await expect(second.locator("svg")).toBeVisible(); await expect(second).toHaveAttribute("title", "查看原消息"); await expect(second).toBeEnabled();
    // Identical text: only the canonical ID can choose the second bubble.
    await second.click(); await located(f.ids.same[1]!);
    await expect(f.bubble(f.ids.same[1]!)).toContainText(same);
    await expect(composer).toHaveValue("未发送的主输入框草稿");
    await page.screenshot({ path: info.outputPath(`trace-desktop-${adhd ? "adhd" : "chat"}-located.png`) });
    // Attachment-only rows share a visible preview; their originals still differ.
    await open(); await expect(editor).toHaveValue("未保存的队列修改");
    await expect(f.row(f.ids.image[0]!).locator(".prompt-queue-text")).toHaveText(await f.row(f.ids.image[1]!).locator(".prompt-queue-text").innerText());
    await source(f.ids.image[1]!).click(); await located(f.ids.image[1]!);
    await expect(f.bubble(f.ids.image[1]!).locator(".image-thumbnail img")).toBeVisible();
    await open(); await source(f.ids.file).click(); await located(f.ids.file);
    await expect(f.bubble(f.ids.file)).toContainText("队列说明.txt");
    // Another device reorders while the drawer is closed. Buttons follow IDs.
    const before = await f.queue.read("owner", "alpha", f.chat.id);
    expect(before.revision).toBe(initial.revision);
    const moved = await f.queue.mutate("owner", f.chat.id, { botId: "alpha", requestId: "trace-host-move", revision: before.revision, action: { type: "move", messageId: f.ids.same[1]!, beforeId: f.ids.same[0]! } });
    await open();
    await expect(panel.locator(".prompt-queue-item").first()).toHaveAttribute("data-queue-message-id", f.ids.same[1]!);
    await panel.getByRole("button", { name: "查看第 2 条原消息", exact: true }).click(); await located(f.ids.same[0]!);
    await open(); await panel.getByRole("button", { name: "查看第 1 条原消息", exact: true }).click(); await located(f.ids.same[1]!);
    expect(f.writes).toEqual([]); expect(f.sends).toEqual([]);
    expect((await f.queue.read("owner", "alpha", f.chat.id)).revision).toBe(moved.revision);
    expect(await f.queued()).toEqual([f.ids.same[1], f.ids.same[0], ...f.ids.image, f.ids.file, ...f.ids.fillers]);
    expect(blocksText((await f.hub.store.messageForUser("owner", f.ids.same[0]!)).blocks)).toBe(same);
    expect(await f.hub.store.db.all("SELECT id FROM messages WHERE conversation_id=?", [f.chat.id])).toHaveLength(65);
    await expect(composer).toHaveValue("未发送的主输入框草稿");
    if (!adhd) {
      await open(); const list = panel.locator(".prompt-queue-list");
      await list.evaluate(node => { node.scrollTop = 0; });
      const grip = f.row(f.ids.image[0]!).getByRole("button", { name: "拖动调整第 3 条消息", exact: true });
      const first = (await f.row(f.ids.same[1]!).boundingBox())!, handle = (await grip.boundingBox())!, x = handle.x + handle.width / 2;
      await page.mouse.move(x, handle.y + handle.height / 2); await page.mouse.down();
      await page.mouse.move(x, handle.y + handle.height / 2 - 24, { steps: 4 });
      await expect(list).toHaveAttribute("data-dragging", "true");
      // Keyboard activation during a pointer drag must not navigate away.
      await source(f.ids.same[0]!).focus(); await page.keyboard.press("Enter");
      await expect(panel).toBeVisible();
      // The release that follows a real drag is not a source click either.
      await page.mouse.move(x, first.y + 8, { steps: 6 }); await page.mouse.up();
      await expect.poll(f.queued).toEqual([f.ids.image[0], f.ids.same[1], f.ids.same[0], f.ids.image[1], f.ids.file, ...f.ids.fillers]);
      await expect(panel).toBeVisible(); await expect(f.bubble(f.ids.image[0]!)).not.toHaveClass(/focused-message/);
      expect(f.writes).toHaveLength(1);
      await expect(panel.locator(".prompt-queue-item").first()).toHaveAttribute("data-queue-message-id", f.ids.image[0]!);
      await panel.getByRole("button", { name: "查看第 1 条原消息", exact: true }).click(); await located(f.ids.image[0]!);
    }
    await open(); await expect(editor).toHaveValue("未保存的队列修改");
    expect(f.sends).toEqual([]); expect(f.errors).toEqual([]);
  } finally { await f.close(); }
});

test("phone source buttons keep 44px targets and locate cached originals while offline", async ({ browser }, info) => {
  test.setTimeout(120_000);
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, serviceWorkers: "block" });
  const page = await context.newPage(), f = await fixture(page, 30);
  try {
    const composer = page.getByRole("textbox", { name: "消息", exact: true }); await composer.fill("手机输入框草稿");
    const trigger = page.getByRole("button", { name: /管理待执行消息，共/ }), panel = page.getByRole("dialog", { name: "待执行消息", exact: true });
    const source = (id: string) => f.row(id).getByRole("button", { name: /^查看第 \d+ 条原消息$/ });
    const located = async (id: string) => {
      await expect(panel).toHaveCount(0);
      await expect(f.bubble(id)).toHaveClass(/focused-message/); await expect(f.bubble(id)).toBeInViewport();
      await expect(f.focused()).toHaveCount(1);
    };
    await trigger.tap(); await expect(panel.locator(".prompt-queue-item").first()).toBeVisible();
    await page.screenshot({ path: info.outputPath("trace-phone-panel.png") });
    for (const id of [...f.ids.same, ...f.ids.image, f.ids.file]) {
      const box = (await source(id).boundingBox())!;
      expect(box.height).toBeGreaterThanOrEqual(44); expect(box.width).toBeGreaterThanOrEqual(44);
    }
    await source(f.ids.same[1]!).tap(); await located(f.ids.same[1]!);
    await expect(composer).toHaveValue("手机输入框草稿");
    await page.screenshot({ path: info.outputPath("trace-phone-located.png") });
    // Offline, the retained snapshot and local history still identify the source.
    await context.setOffline(true);
    for (const client of (f.hub as unknown as { clients: Set<{ ws: { close(): void } }> }).clients) client.ws.close();
    await expect(page.locator(".connection-pill.online")).toHaveCount(0);
    await expect(trigger).toContainText("离线");
    await trigger.tap(); await expect(panel.getByRole("status")).toContainText("离线时仅可查看");
    await expect(panel.getByRole("button", { name: "编辑第 4 条消息", exact: true })).toBeDisabled();
    await expect(source(f.ids.image[1]!)).toBeEnabled();
    await source(f.ids.image[1]!).tap(); await located(f.ids.image[1]!);
    await expect(f.bubble(f.ids.image[1]!).locator(".image-thumbnail img")).toBeVisible();
    await expect(composer).toHaveValue("手机输入框草稿");
    expect(f.writes).toEqual([]); expect(f.sends).toEqual([]); expect(f.errors).toEqual([]);
    await context.setOffline(false);
  } finally { await f.close(); await context.close(); }
});

test("narrow English source buttons fit and a missing original reports the existing error", async ({ page }, info) => {
  test.setTimeout(120_000);
  const f = await fixture(page, 0), ghost = "missing_queue_source";
  try {
    await openSettings(page, "general"); await page.locator("#language").selectOption("en");
    await expect(page.locator("html")).toHaveAttribute("lang", "en"); await closeSettings(page, true);
    // A queued row whose original is absent from local history.
    await page.route(url => url.pathname === `/api/conversations/${f.chat.id}/queue`, async route => {
      if (route.request().method() !== "GET") { await route.continue(); return; }
      const response = await route.fetch(), body = await response.json();
      const template = body.items.find((item: { state: string }) => item.state === "queued");
      if (template) body.items.unshift({ ...template, canEdit: false, canCancel: false, canMove: false, canPause: false, canResume: false, message: { ...template.message, id: ghost, clientMsgId: "missing-queue-source", blocks: [{ type: "text", text: "A source that is no longer cached" }] } });
      await route.fulfill({ response, json: body });
    });
    await page.setViewportSize({ width: 320, height: 700 });
    await page.getByRole("button", { name: /^Manage \d+ pending messages$/ }).click();
    const panel = page.getByRole("dialog", { name: "Pending messages", exact: true }), rows = panel.locator(".prompt-queue-item");
    await expect(rows).toHaveCount(6); await expect(rows.first()).toHaveAttribute("data-queue-message-id", ghost);
    const second = rows.nth(1).getByRole("button", { name: "View source of message 2", exact: true });
    await expect(second).toHaveText(""); await expect(second.locator("svg")).toBeVisible(); await expect(second).toHaveAttribute("title", "View original message");
    // Every heading keeps its number, time, source arrow and drag handle apart.
    // Resizing from settings to a phone and adding the synthetic row can still
    // be laying out. Assert the same geometry after that transition settles.
    const problems = () => rows.evaluateAll(nodes => nodes.flatMap(node => {
      const row = node as HTMLElement, heading = row.querySelector(".prompt-queue-item-heading")!, button = heading.querySelector<HTMLElement>(".prompt-queue-source");
      if (!button) return [`${row.dataset.queueMessageId}:missing`];
      const label = heading.querySelector("strong")!, time = heading.querySelector("time")!, grip = heading.querySelector(".prompt-queue-grip");
      const box = button.getBoundingClientRect(), issues: string[] = [];
      if (button.textContent?.trim()) issues.push("unexpected-label");
      if (box.height < 44 || box.width < 44) issues.push("target");
      if (button.scrollWidth > button.clientWidth + 1 || label.scrollWidth > label.clientWidth + 1 || heading.scrollWidth > heading.clientWidth + 1) issues.push("clipped");
      if (box.left < time.getBoundingClientRect().right - .5 || grip && box.right > grip.getBoundingClientRect().left + .5) issues.push("overlap");
      if (box.right > row.getBoundingClientRect().right || box.right > innerWidth) issues.push("overflow");
      return issues.length ? [`${row.dataset.queueMessageId}:${issues.join(",")}`] : [];
    }));
    await expect.poll(problems).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
    await page.screenshot({ path: info.outputPath("trace-phone-320-en-panel.png") });
    await rows.first().getByRole("button", { name: "View source of message 1", exact: true }).click();
    await expect(panel).toHaveCount(0);
    await expect(page.locator(".error-banner")).toContainText("The original message was deleted or is unavailable");
    await expect(f.focused()).toHaveCount(0);
    await page.screenshot({ path: info.outputPath("trace-phone-320-en-missing.png") });
    await page.getByRole("button", { name: /^Manage \d+ pending messages$/ }).click();
    await panel.getByRole("button", { name: "View source of message 2", exact: true }).click();
    await expect(panel).toHaveCount(0);
    await expect(f.bubble(f.ids.same[0]!)).toHaveClass(/focused-message/); await expect(f.bubble(f.ids.same[0]!)).toBeInViewport();
    await expect(f.focused()).toHaveCount(1);
    expect(f.writes).toEqual([]); expect(f.sends).toEqual([]); expect(f.errors).toEqual([]);
  } finally { await page.unrouteAll({ behavior: "ignoreErrors" }); await f.close(); }
});
