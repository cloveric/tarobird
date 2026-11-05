import { preparePairing } from "./fixtures/pairing-invite.js";
import { singleHostCacheName } from "./fixtures/cache.js";
import { showDisconnectedBots, selectConversation } from "./fixtures/mobile.js";
import { waitForClientOnline } from "./fixtures/mobile.js";
import { test, expect, type Page } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HubServer } from "../../src/hub/server.js";
import { hashSecret } from "../../src/hub/auth.js";
import { HubError } from "../../src/hub/store.js";
import { attachGateway } from "../../src/gateway/service.js";
import { createCoreServiceRuntime } from "../../src/core/runtime.js";
import { createServer } from "./fixtures/vite.js";
import type { Message } from "../../src/client-protocol/index.js";
import type { ClientCache } from "../src/storage.js";
import { questionDraftKey, type QuestionData } from "../src/question-draft.js";

test("native questions preserve edits, custom answers and limits, and resolve across devices", async ({ browser }, info) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "native-questions-")), stateDir = path.join(root, "instance");
  await mkdir(stateDir); await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ engine: "claude", locale: "zh" }));
  const hub = await HubServer.start({ stateDir: path.join(root, "hub"), clientDir: path.resolve("dist") });
  const secret = randomBytes(32).toString("base64url"), decisions: unknown[] = [];
  await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','产品助手',?)", [hashSecret(secret)]);
  const gateway = await attachGateway({ stateDir, url: hub.instanceUrl.replace("http", "ws") + "/instance", botId: "alpha", secret, engine: "claude", runtime: createCoreServiceRuntime(), bridge: { handleAuthorizedMessage: async (input) => {
    decisions.push(await input.onApprovalRequest?.({ engine: "claude", toolName: "AskUserQuestion", toolInput: { questions: [
      { header: "连接方式", question: "你希望手机怎样连接主电脑？", options: [{ label: "自动选择（推荐）", description: "在家使用局域网，外出时切换到已配置的远程线路。" }, { label: "只在局域网使用", description: "不需要额外服务器，离开家后暂时无法连接。" }] },
      { header: "同步内容", question: "请选择两项需要优先同步的内容。", multiSelect: true, minSelections: 2, maxSelections: 2, options: [{ label: "聊天记录", description: "在手机和电脑上继续同一段对话。" }, { label: "附件", description: "从不同设备查看图片和文件。" }, { label: "通知", description: "任务完成时提醒我。" }] },
    ] } }));
    return { text: "已按你的回答继续处理" };
  } } });
  await hub.store.createConversation("owner", ["alpha"], "客户端体验", "question-fixture");
  await hub.store.createConversation("owner", ["alpha"], "另一段对话", "other-fixture");
  const desktopContext = await browser.newContext({ viewport: { width: 1360, height: 900 } }), phoneContext = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const desktop = await desktopContext.newPage(), phone = await phoneContext.newPage();
  async function pair(page: Page) {
    await page.goto(hub.url); await preparePairing(page, hub); await page.getByRole("button", { name: "配对此设备", exact: true }).click();
    await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
    await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" }); await waitForClientOnline(page);
  }
  async function select(page: Page, title: string, parentTitle?: string) { await selectConversation(page, title, parentTitle); }
  try {
    await pair(desktop); await pair(phone); await select(desktop, "客户端体验"); await select(phone, "客户端体验");
    await desktop.getByRole("textbox", { name: "消息", exact: true }).fill("请确认客户端设置"); await desktop.getByRole("button", { name: "发送消息", exact: true }).click();
    for (const page of [desktop, phone]) {
      await expect(page.getByRole("radio", { name: "自动选择（推荐）", exact: true })).not.toBeChecked();
      await expect(page.getByText("在家使用局域网，外出时切换到已配置的远程线路。", { exact: true })).toBeVisible();
    }
    // Unsubmitted native answers must survive changing chats and a page reload,
    // including which question was being edited. They must not auto-submit.
    await desktop.locator('textarea[name="q0_other"]').fill("桌面尚未提交的草稿");
    await desktop.getByRole("button", { name: "下一题", exact: true }).click();
    await desktop.getByRole("checkbox", { name: "聊天记录", exact: true }).check();
    await select(desktop, "另一段对话"); await select(desktop, "客户端体验");
    await expect(desktop.getByRole("checkbox", { name: "聊天记录", exact: true })).toBeChecked();
    await desktop.reload(); await waitForClientOnline(desktop);
    await expect(desktop.getByRole("checkbox", { name: "聊天记录", exact: true })).toBeChecked();
    await desktop.getByRole("button", { name: "上一题", exact: true }).click();
    await expect(desktop.locator('textarea[name="q0_other"]')).toHaveValue("桌面尚未提交的草稿");
    await expect(phone.locator('textarea[name="q0_other"]')).toHaveValue("");
    expect(decisions).toHaveLength(0);
    await phone.getByRole("button", { name: "下一题", exact: true }).click();
    await expect(phone.getByText("请先回答这个问题", { exact: true })).toBeVisible(); expect(decisions).toHaveLength(0);
    await phone.getByRole("radio", { name: "自动选择（推荐）", exact: true }).check();
    await phone.locator('textarea[name="q0_other"]').fill("在家直连，出门由我手动选择线路");
    await expect(phone.getByRole("radio", { name: "自动选择（推荐）", exact: true })).not.toBeChecked();
    // A delayed rendering frame must not steal focus after the user has already
    // entered the next answer. Reproduces the real WebKit MCP form's lost input
    // without another paid model turn or relying on a timing-sensitive sleep.
    await phone.evaluate(() => {
      const target = window as typeof window & { releaseQuestionFrames?: () => void };
      const request = target.requestAnimationFrame, cancel = target.cancelAnimationFrame;
      const held = new Map<number, FrameRequestCallback>(); let id = 0;
      target.requestAnimationFrame = (callback) => { held.set(--id, callback); return id; };
      target.cancelAnimationFrame = (value) => { if (!held.delete(value)) cancel.call(target, value); };
      target.releaseQuestionFrames = () => {
        target.requestAnimationFrame = request; target.cancelAnimationFrame = cancel;
        delete target.releaseQuestionFrames;
        for (const callback of held.values()) callback(performance.now());
      };
    });
    await phone.getByRole("button", { name: "下一题", exact: true }).click();
    const nextAnswer = phone.locator('textarea[name="q1_other"]');
    const nextHeading = phone.getByRole("region", { name: "回答问题", exact: true }).getByRole("heading", { name: "同步内容", exact: true });
    await expect(nextHeading).toBeFocused();
    await nextAnswer.focus();
    await phone.evaluate(() => (window as typeof window & { releaseQuestionFrames: () => void }).releaseQuestionFrames());
    await expect(nextAnswer).toBeFocused();
    await phone.keyboard.insertText("手机确认"); await expect(nextAnswer).toHaveValue("手机确认");
    await nextAnswer.fill("");
    // Same-step actions must complete their focus work even when every other
    // state value is unchanged. A ref-only request can survive React's bailout
    // and steal focus on the first later keystroke instead.
    for (let attempt = 0; attempt < 2; attempt++) {
      await phone.getByRole("button", { name: "提交", exact: true }).click();
      await expect(phone.getByText("请先回答这个问题", { exact: true })).toBeVisible();
      await expect(nextHeading).toBeFocused();
    }
    await nextAnswer.click(); await phone.keyboard.insertText("补充");
    await expect(nextAnswer).toBeFocused(); await expect(nextAnswer).toHaveValue("补充");
    await nextAnswer.fill("");
    for (let attempt = 0; attempt < 2; attempt++) {
      await phone.getByRole("button", { name: "第 2 题：同步内容", exact: true }).click();
      await expect(nextHeading).toBeFocused();
    }
    await nextAnswer.click(); await phone.keyboard.insertText("继续填写");
    await expect(nextAnswer).toBeFocused(); await expect(nextAnswer).toHaveValue("继续填写");
    await nextAnswer.fill("");
    await phone.getByRole("checkbox", { name: "聊天记录", exact: true }).check();
    await phone.getByRole("button", { name: "提交", exact: true }).click();
    await expect(phone.getByText("所选数量不符合要求", { exact: true })).toBeVisible(); expect(decisions).toHaveLength(0);
    await phone.getByRole("checkbox", { name: "附件", exact: true }).check();
    await phone.getByRole("checkbox", { name: "通知", exact: true }).check();
    await phone.getByRole("button", { name: "提交", exact: true }).click();
    await expect(phone.getByText("所选数量不符合要求", { exact: true })).toBeVisible(); expect(decisions).toHaveLength(0);
    await phone.getByRole("checkbox", { name: "通知", exact: true }).uncheck();
    await phone.getByRole("button", { name: "上一题", exact: true }).click();
    await expect(phone.getByRole("region", { name: "回答问题", exact: true }).getByRole("heading", { name: "连接方式", exact: true })).toBeFocused();
    await expect(phone.getByRole("region", { name: "回答问题", exact: true })).toContainText("你希望手机怎样连接主电脑？");
    await expect(phone.locator('textarea[name="q0_other"]')).toHaveValue("在家直连，出门由我手动选择线路");
    await phone.screenshot({ path: info.outputPath("native-question-phone.png"), animations: "disabled" });
    await desktop.getByRole("radio", { name: "自动选择（推荐）", exact: true }).focus(); await desktop.keyboard.press("ArrowDown");
    await expect(desktop.getByRole("radio", { name: "只在局域网使用", exact: true })).toBeChecked();
    await desktop.screenshot({ path: info.outputPath("native-question-desktop.png"), animations: "disabled" });
    await phone.getByRole("button", { name: "下一题", exact: true }).click();
    await expect(phone.getByRole("checkbox", { name: "聊天记录", exact: true })).toBeChecked();
    await expect(phone.getByRole("checkbox", { name: "附件", exact: true })).toBeChecked();
    expect(await phone.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await phone.evaluate(() => document.documentElement.dataset.theme = "dark");
    await phone.screenshot({ path: info.outputPath("native-question-phone-dark.png"), animations: "disabled" });
    const enqueue = hub.store.enqueueAction.bind(hub.store);
    hub.store.enqueueAction = async () => { throw new HubError("fixture_storage_unavailable", 503); };
    await phone.getByRole("button", { name: "提交", exact: true }).click();
    await expect(phone.getByRole("button", { name: "提交", exact: true })).toBeDisabled();
    await expect(phone.getByText("答案发送失败，请在待发送项中重试或移除。", { exact: true })).toBeVisible({ timeout: 15000 });
    expect(decisions).toHaveLength(0);
    await phone.reload(); await waitForClientOnline(phone); await select(phone, "客户端体验");
    await expect(phone.getByRole("checkbox", { name: "聊天记录", exact: true })).toBeChecked();
    await expect(phone.getByRole("checkbox", { name: "附件", exact: true })).toBeChecked();
    await expect(phone.getByRole("button", { name: "提交", exact: true })).toBeDisabled();
    hub.store.enqueueAction = enqueue;
    await phone.getByRole("button", { name: "重试", exact: true }).click();
    for (const page of [desktop, phone]) {
      await expect(page.locator(".message-body").getByText("已按你的回答继续处理", { exact: true })).toBeVisible();
      await expect(page.getByRole("region", { name: "回答问题", exact: true })).toHaveCount(0);
    }
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({ behavior: "allow", updatedInput: { answers: { "你希望手机怎样连接主电脑？": "在家直连，出门由我手动选择线路", "请选择两项需要优先同步的内容。": "聊天记录, 附件" } } });
  } finally { await desktopContext.close(); await phoneContext.close(); await gateway.disconnect(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});

test("same-step question focus completes before typing even while draft storage is delayed", async ({ page }) => {
  const server = await createServer({ server: { port: 0, strictPort: false, host: "127.0.0.1" } }); await server.listen();
  try {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(server.resolvedUrls!.local[0] + "e2e/fixtures/question-focus.html");
    const first = page.locator('textarea[name="q0_other"]');
    await expect(first).toBeEnabled(); await expect(first).not.toBeFocused();
    await first.fill("第一项");
    await page.getByRole("button", { name: "下一题", exact: true }).click();
    const heading = page.getByRole("heading", { name: "第二题", exact: true });
    const answer = page.locator('textarea[name="q1_other"]');
    await expect(heading).toBeFocused();
    // No value or error changes here, so a ref cannot force a React commit.
    for (let attempt = 0; attempt < 2; attempt++) {
      await page.getByRole("button", { name: "第 2 题：第二题", exact: true }).click();
      await expect(heading).toBeFocused();
    }
    for (let attempt = 0; attempt < 2; attempt++) {
      await page.getByRole("button", { name: "提交", exact: true }).click();
      await expect(page.getByText("请先回答这个问题", { exact: true })).toBeVisible();
      await expect(heading).toBeFocused();
    }
    await answer.click(); await page.keyboard.insertText("第一字");
    await expect(answer).toBeFocused(); await page.keyboard.insertText("第二字");
    await expect(answer).toHaveValue("第一字第二字");
    await page.getByRole("button", { name: "上一题", exact: true }).click();
    await expect(page.getByRole("heading", { name: "第一题", exact: true })).toBeFocused();
    await expect(first).toHaveValue("第一项");
  } finally { await page.close(); await server.close(); }
});

test("question drafts follow form identity, survive snapshots and cannot return after resolution or identity reset", async ({ page }) => {
  const server = await createServer({ server: { port: 0, strictPort: false, host: "127.0.0.1" } }); await server.listen();
  const data: QuestionData = { version: 1, requestId: "question_a", questions: [{ question: "选择任务", header: "任务", multiSelect: false, required: true, allowFreeText: true, options: [{ label: "搜索" }, { label: "导出" }] }] };
  const message: Message = { id: "form_a", conversationId: "chat_a", authorId: "alpha", authorType: "bot", status: "complete", version: 1, createdAt: 1, blocks: [{ type: "card", elements: [{ type: "form", extra: { tarocub_questions: data }, children: [{ type: "button", name: "askq_submit", actionId: "answer", extra: { form_action_type: "submit" } }] }] }] };
  const changed = structuredClone(data); changed.questions[0]!.options.reverse();
  const changedMessage = structuredClone(message); changedMessage.version = 3;
  if (changedMessage.blocks[0]!.type === "card") changedMessage.blocks[0].elements[0]!.extra = { tarocub_questions: changed };
  const key = questionDraftKey(message.id, data), nextKey = questionDraftKey(message.id, changed), otherKey = questionDraftKey("form_b", data);
  try {
    await page.goto(server.resolvedUrls!.local[0] + "e2e/fixtures/stream.html"); await page.waitForFunction(() => "streamCache" in window);
    const result = await page.evaluate(async ({ message, changedMessage, key, nextKey, otherKey }) => {
      const cache = (window as unknown as { streamCache: ClientCache }).streamCache;
      const identity = { deviceId: "draft_device", name: "fixture", publicKey: "fixture", hubPublicKey: "fixture_hub", routes: [] };
      await cache.saveIdentity(identity);
      const keys = async () => {
        const db = await new Promise<IDBDatabase>((resolve, reject) => { const r = indexedDB.open("tarocub-v1"); r.onsuccess = () => resolve(r.result); r.onerror = reject; });
        try { return await new Promise<string[]>((resolve, reject) => { const r = db.transaction("settings").objectStore("settings").getAllKeys(); r.onsuccess = () => resolve(r.result.map(String).filter((k) => k.startsWith("question-draft:")).sort()); r.onerror = reject; }); } finally { db.close(); }
      };
      const apply = (m: Message, seq: number) => cache.apply({ v: 1, type: "event", conversationId: m.conversationId, seq, kind: "message.updated", payload: m, at: seq });
      await apply(message, 1);
      const firstWrite = cache.saveQuestionDraft(message.id, key, { values: { q0_other: "first" }, step: 0 }, identity);
      const secondWrite = cache.saveQuestionDraft(message.id, key, { values: { q0_other: "latest" }, step: 0 }, identity);
      const immediate = await cache.questionDraft(message.id, key, identity); await Promise.all([firstWrite, secondWrite]);
      const other: Message = { ...message, id: "form_b", conversationId: "chat_b" }; await apply(other, 1);
      await cache.saveQuestionDraft(other.id, otherKey, { values: { q0: "1" }, step: 0 }, identity);
      await apply({ ...message, version: 2 }, 2);
      const unchanged = await cache.questionDraft(message.id, key, identity);
      await apply(changedMessage, 3);
      await cache.saveQuestionDraft(message.id, key, { values: { q0_other: "stale render" }, step: 0 }, identity);
      const afterSchemaChange = await keys();
      await cache.saveQuestionDraft(message.id, nextKey, { values: { q0_other: "new options" }, step: 0 }, identity);
      const conversation = { id: "chat_a", type: "direct" as const, title: "Draft", ownerId: "owner", botIds: ["alpha"], archived: false, createdAt: 1 };
      await cache.acceptSnapshot({ v: 1, type: "snapshot.begin", id: "keep", conversation, seq: 100, after: 3, readSeq: 0 });
      await cache.acceptSnapshot({ v: 1, type: "snapshot.message", id: "keep", index: 0, message: changedMessage, contentSeq: 100, unreadSeq: 0 });
      await cache.acceptSnapshot({ v: 1, type: "snapshot.end", id: "keep", count: 1 });
      const snapshotPreserved = await cache.questionDraft(message.id, nextKey, identity);
      await cache.acceptSnapshot({ v: 1, type: "snapshot.begin", id: "remove", conversation, seq: 200, after: 100, readSeq: 0 });
      await cache.acceptSnapshot({ v: 1, type: "snapshot.end", id: "remove", count: 0 });
      const afterSnapshotRemoval = await keys();
      await apply({ ...other, version: 2, blocks: [{ type: "text", text: "已提交" }] }, 2);
      await cache.saveQuestionDraft(other.id, otherKey, { values: { q0_other: "late after resolve" }, step: 0 }, identity);
      const afterResolution = await keys();
      await apply({ ...other, version: 3 }, 3);
      await cache.saveQuestionDraft(other.id, otherKey, { values: { q0_other: "private old identity" }, step: 0 }, identity);
      await cache.saveIdentity({ ...identity, deviceId: "replacement", hubPublicKey: "replacement_hub" });
      await cache.saveQuestionDraft(other.id, otherKey, { values: { q0_other: "late old identity" }, step: 0 }, identity);
      return { immediate, unchanged, afterSchemaChange, snapshotPreserved, afterSnapshotRemoval, afterResolution, afterIdentityChange: await keys() };
    }, { message, changedMessage, key, nextKey, otherKey });
    expect(result.immediate).toEqual({ values: { q0_other: "latest" }, step: 0 }); expect(result.unchanged).toEqual(result.immediate);
    expect(result.afterSchemaChange).toEqual([otherKey]);
    expect(result.snapshotPreserved).toEqual({ values: { q0_other: "new options" }, step: 0 });
    expect(result.afterSnapshotRemoval).toEqual([otherKey]); expect(result.afterResolution).toEqual([]); expect(result.afterIdentityChange).toEqual([]);
  } finally { await page.close(); await server.close(); }
});

test("async free-text questions show every prompt, retain offline answers and settle on both devices", async ({ browser }, info) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "async-questions-")), stateDir = path.join(root, "instance");
  await mkdir(stateDir); await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ engine: "codex", locale: "zh" }));
  const hub = await HubServer.start({ stateDir: path.join(root, "hub"), clientDir: path.resolve("dist") });
  const secret = randomBytes(32).toString("base64url"), replies: string[] = [];
  await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','整理助手',?)", [hashSecret(secret)]);
  const runtime = createCoreServiceRuntime();
  const gateway = await attachGateway({ stateDir, url: hub.instanceUrl.replace("http", "ws") + "/instance", botId: "alpha", secret, engine: "codex", runtime, bridge: { handleAuthorizedMessage: async input => {
    if (replies.length === 0) {
      replies.push(input.text);
      await input.onEngineEvent?.({ type: "user_input_request", toolName: "request_user_input_async", requestId: "async_fixture", toolInput: { questions: [
        { title: "有几项内容还不确定，你希望怎样整理？" }, { title: "整理完成后用什么格式展示？", options: ["表格", "清单"] },
      ] } });
      return { text: "我先继续处理其他内容，等你补充。" };
    }
    replies.push(input.text); return { text: "已收到两项回答，按你的要求继续整理。" };
  } } });
  const conversation = await hub.store.createConversation("owner", ["alpha"], "整理资料", "async-browser");
  const desktopContext = await browser.newContext(), phoneContext = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const desktop = await desktopContext.newPage(), phone = await phoneContext.newPage();
  async function pair(page: Page) {
    await page.goto(hub.url); await preparePairing(page, hub); await page.getByRole("button", { name: "配对此设备", exact: true }).click();
    await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
    await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" }); await waitForClientOnline(page); await selectConversation(page, conversation.title);
  }
  try {
    await pair(desktop); await pair(phone);
    await desktop.getByRole("textbox", { name: "消息", exact: true }).fill("帮我整理资料"); await desktop.getByRole("button", { name: "发送消息", exact: true }).click();
    for (const page of [desktop, phone]) {
      await expect(page.getByRole("region", { name: "回答问题", exact: true })).toBeVisible();
      await expect(page.getByText("有几项内容还不确定，你希望怎样整理？", { exact: true })).toHaveCount(1);
      await expect(page.locator('textarea[name="q0_other"]')).toBeEnabled();
    }
    await expect.poll(() => runtime.chatQueue.isBusy(`lark:${conversation.id}`)).toBe(false);
    await phone.locator('textarea[name="q0_other"]').fill("不确定的单独列出，其他照常整理");
    await phone.screenshot({ path: info.outputPath("async-question-phone.png"), animations: "disabled" });
    await phone.getByRole("button", { name: "下一题", exact: true }).click();
    await phone.getByRole("radio", { name: "表格", exact: true }).check();
    // Reload only after the queued IndexedDB save has committed.
    await phone.waitForFunction(async databaseName => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => { const request = indexedDB.open(databaseName); request.onsuccess = () => resolve(request.result); request.onerror = reject; });
      try { return await new Promise<boolean>((resolve, reject) => {
        const request = db.transaction("settings").objectStore("settings").getAll();
        request.onsuccess = () => resolve(request.result.some(value => typeof value === "string" && value.includes('"q1":"0"'))); request.onerror = reject;
      }); } finally { db.close(); }
    }, await singleHostCacheName(phone));
    // WebKit's offline flag leaves established WebSockets connected. Reload
    // from the saved draft while explicitly withholding socket handshakes.
    await showDisconnectedBots(phone);
    let offline = true;
    await phone.routeWebSocket("**/ws", socket => { if (!offline) socket.connectToServer(); });
    await phone.reload(); await selectConversation(phone, conversation.title);
    await expect(phone.getByRole("radio", { name: "表格", exact: true })).toBeChecked();
    await phone.getByRole("button", { name: "提交", exact: true }).click();
    await expect(phone.getByText("答案已保存，联网后自动提交。", { exact: true })).toBeVisible();
    expect(replies).toHaveLength(1);
    offline = false; await phone.reload(); await waitForClientOnline(phone); await selectConversation(phone, conversation.title);
    for (const page of [desktop, phone]) {
      await expect(page.getByRole("region", { name: "回答问题", exact: true })).toHaveCount(0);
      await expect(page.locator(".message-body").getByText("已收到两项回答，按你的要求继续整理。", { exact: true })).toBeVisible();
    }
    expect(replies).toHaveLength(2); expect(replies[1]).toContain("不确定的单独列出，其他照常整理"); expect(replies[1]).toContain("表格");
    expect(await phone.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await phone.screenshot({ path: info.outputPath("async-question-submitted-phone.png"), animations: "disabled" });
  } finally { await desktopContext.close(); await phoneContext.close(); await gateway.disconnect(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});

test("single native question has one heading, no redundant progress, and still submits a custom answer", async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const root = await mkdtemp(path.join(os.tmpdir(), "one-question-"));
  const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve("dist") });
  try {
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','产品助手','fixture')");
    const chat = await hub.store.createConversation("owner", ["alpha"], "确认事项", "one-question");
    const data: QuestionData = { version: 1, requestId: "one", questions: [{ header: "问题 1", question: "是否已经允许磁盘访问？", multiSelect: false, required: true, allowFreeText: true, options: [{ label: "已允许访问" }, { label: "现在不在电脑旁" }] }] };
    await hub.store.publishBotMessage("alpha", { conversationId: chat.id, blocks: [{ type: "card", title: "问题 1", elements: [{ type: "form", extra: { tarocub_questions: data }, children: [{ type: "button", name: "askq_submit", actionId: "one-answer", extra: { form_action_type: "submit" } }] }] }] });
    await page.goto(hub.url); await preparePairing(page, hub); await page.getByRole("button", { name: "配对此设备", exact: true }).click();
    await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
    await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" }); await waitForClientOnline(page); await showDisconnectedBots(page); await selectConversation(page, chat.title);
    const form = page.getByRole("region", { name: "回答问题", exact: true });
    await expect(form.getByRole("heading")).toHaveText("请确认");
    await expect(page.locator(".question-progress")).toHaveCount(0); await expect(page.locator(".card-header")).toHaveCount(0);
    await expect(form.getByRole("button", { name: "上一题", exact: true })).toHaveCount(0);
    await form.locator('textarea[name="q0_other"]').fill("没看到提示，现在不在电脑旁");
    await page.screenshot({ path: info.outputPath("single-question-phone.png"), animations: "disabled" });
    expect(await hub.store.pendingActions("alpha")).toEqual([]);
    await form.getByRole("button", { name: "提交", exact: true }).click();
    await expect.poll(async () => (await hub.store.pendingActions("alpha")).length).toBe(1);
  } finally { await page.close(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});
