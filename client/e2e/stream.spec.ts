import { preparePairing } from "./fixtures/pairing-invite.js";
import { selectConversation, showDisconnectedBots, waitForClientOnline } from "./fixtures/mobile.js";
import { singleHostCacheName } from "./fixtures/cache.js";
import { test, expect } from "@playwright/test";
import { createServer } from "./fixtures/vite.js";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HubServer } from "../../src/hub/server.js";
import { hashSecret } from "../../src/hub/auth.js";
import { type Block, type HubEvent, type Message } from "../../src/client-protocol/index.js";
import type { ClientCache } from "../src/storage.js";
import { initialCoreRunState, renderCoreRunCard } from "../../src/core/card-renderer.js";
import { withChannelProfile } from "../../src/core/channel-profile.js";
import { translateCard } from "../../src/gateway/card-translator.js";
import { GatewayChannel } from "../../src/gateway/channel.js";
import type { GatewayTransport } from "../../src/gateway/transport.js";
import { RunJournal } from "../../src/hub/run-journal.js";
import { createRunRecord, recordRunEvent } from "../../src/core/run-record.js";

for (const width of [390, 1360]) test(`failed final broadcast reconnects and completes the visible reply without losing the draft (${width})`, async ({ page }) => {
  await page.setViewportSize({ width, height: 900 });
  const root = await mkdtemp(path.join(os.tmpdir(), "stream-reconnect-"));
  const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve("dist") });
  let connections = 0;
  page.on("websocket", socket => { if (socket.url() === hub.url.replace("http", "ws") + "/ws") connections++; });
  try {
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash,online) VALUES('bot','恢复助手','fixture',1)");
    const chat = await hub.store.createConversation("owner", ["bot"], "广播恢复", "recovery");
    await page.goto(hub.url); await preparePairing(page, hub); await page.getByRole("button", { name: "配对此设备", exact: true }).click();
    await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
    await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" });
    await waitForClientOnline(page); await showDisconnectedBots(page); await selectConversation(page, chat.title);
    const message = await hub.store.publishBotMessage("bot", { conversationId: chat.id, blocks: [{ type: "text", text: "正在写报告" }], status: "streaming" });
    const row = page.locator(`[data-message-id="${message.id}"]`);
    await expect(row).toContainText("正在写报告");
    const composer = page.getByRole("textbox", { name: "消息", exact: true });
    await composer.fill("下一条草稿必须保留");
    const before = connections, project = hub.store.eventProjections.bind(hub.store);
    let failed = false;
    hub.store.eventProjections = async (event, users) => {
      if (!failed && event.kind === "message.updated") { failed = true; throw new Error("isolated final broadcast failure"); }
      return project(event, users);
    };
    await hub.store.publishBotMessage("bot", { id: message.id, conversationId: chat.id, blocks: [{ type: "text", text: "报告完成，重新连接后可见" }], status: "complete" });
    await expect(row).toContainText("报告完成，重新连接后可见", { timeout: 15_000 });
    expect(failed).toBe(true); expect(connections).toBeGreaterThan(before);
    await expect(row).toHaveCount(1); await expect(composer).toHaveValue("下一条草稿必须保留");
    expect((await hub.store.listMessages("owner", chat.id)).messages).toHaveLength(1);
  } finally { await page.close(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});

test("open process details catch up after live text without another engine event", async ({ page }) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "stream-delayed-journal-"));
  const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve("dist") });
  let release!: () => void; const blocked = new Promise<void>(resolve => { release = resolve; });
  const channel = new GatewayChannel({ capabilities: ["runs.v1"], options: { stateDir: root }, disconnect: async () => {}, request: async (method: string, input: unknown) => {
    if (method === "run.write") { await blocked; await new RunJournal(hub.store).write("alpha", input); return null; }
    if (method === "publish") return hub.store.publishBotMessage("alpha", input);
    throw new Error(method);
  } } as unknown as GatewayTransport);
  try {
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','过程助手','fixture')");
    const chat = await hub.store.createConversation("owner", ["alpha"], "日志延迟", "journal");
    await page.goto(hub.url); await preparePairing(page, hub); await page.getByRole("button", { name: "配对此设备", exact: true }).click();
    await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
    await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" });
    const state = initialCoreRunState(chat.id); state.nativeRun = createRunRecord();
    recordRunEvent(state.nativeRun, { type: "tool_use", toolUseId: "read", toolName: "Read", toolInput: { file_path: "/workspace/report.md" } });
    state.blocks = [{ kind: "text", content: "正文已经显示，过程稍后跟上。", streaming: true }];
    const sent = await withChannelProfile("gateway", () => channel.send(chat.id, { card: renderCoreRunCard(state) }));
    await expect(page.locator(".native-run-prose")).toContainText("正文已经显示");
    await page.getByRole("button", { name: "查看运行过程", exact: true }).click();
    await expect(page.getByText("尚无过程记录", { exact: true })).toBeVisible();
    const before = await hub.store.messageForUser("owner", sent.messageId);
    release();
    await expect(page.locator(".run-step")).toHaveCount(1);
    await expect(page.locator(".run-step")).toContainText("report.md");
    expect((await hub.store.messageForUser("owner", sent.messageId)).version).toBe(before.version);
  } finally { release(); await channel.disconnect(); await page.close(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});

for (const palette of ["white-blue", "cli"]) test(`run card width stays stable through reasoning, tools and completion (${palette})`, async ({ page }, info) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "stream-width-"));
  const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve("dist") });
  try {
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('bot','宽度验收','fixture')");
    const chat = await hub.store.createConversation("owner", ["bot"], "思考卡片宽度", "width");
    await page.goto(hub.url); await preparePairing(page, hub); await page.getByRole("button", { name: "配对此设备", exact: true }).click();
    await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
    await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" });
    await expect(page.locator(".host-workspace:not([hidden]) .connection-pill.online")).toBeVisible();
    const setPalette = () => page.evaluate(async palette => {
      document.documentElement.dataset.palette = palette;
      document.documentElement.dataset.theme = palette === "cli" ? "dark" : "light";
      await document.fonts.ready;
    }, palette);
    await setPalette();
    const state = initialCoreRunState(chat.id);
    let id: string | undefined;
    const publish = async () => {
      const message = await hub.store.publishBotMessage("bot", { ...(id ? { id } : {}), conversationId: chat.id,
        blocks: [withChannelProfile("gateway", () => translateCard(renderCoreRunCard(state)))],
        status: state.status === "running" ? "streaming" : "complete" });
      id = message.id;
    };
    await publish();
    const card = page.locator(`[data-message-id="${id}"] .rich-card`);
    await expect(card.getByRole("button", { name: "停止", exact: true })).toBeVisible();
    const initialWidth = (await card.boundingBox())!.width;
    // Observe every layout, including parser fallbacks, instead of measuring only
    // settled snapshots and missing a transient shrink between stream patches.
    await card.evaluate(node => {
      const widths: number[] = [node.getBoundingClientRect().width];
      const observer = new ResizeObserver(() => widths.push(node.getBoundingClientRect().width));
      observer.observe(node); Object.assign(window, { streamWidths: widths });
    });
    state.reasoning = { content: "先看一下。", active: true };
    await publish(); await expect(card.getByText("先看一下。", { exact: true })).toBeVisible();
    state.reasoning.content = "逐项核对输入和已有资料，然后检查不同情况下的结果是否一致。".repeat(16);
    await publish(); await expect(card.locator(".collapse-body")).toContainText(state.reasoning.content);
    expect((await card.boundingBox())!.width).toBeCloseTo(initialWidth, 0);
    state.reasoning.active = false;
    state.footer = "tool_running";
    state.blocks = [{ kind: "tool", tool: { toolName: "exec_command", toolInput: { command: "检查资料" }, status: "running" } }];
    await publish(); await expect(card.locator(".card-collapse")).toHaveCount(2);
    expect((await card.boundingBox())!.width).toBeCloseTo(initialWidth, 0);
    state.footer = "streaming";
    state.blocks = [{ kind: "text", content: "结果如下。", streaming: true }];
    await publish(); await expect(card.getByText("结果如下。", { exact: true })).toBeVisible();
    state.blocks[0].content += "\n\n| 项目 | 说明 |\n| --- | --- |\n| 已检查 | " + "表格内容保持局部滚动。".repeat(30) + " |";
    await publish(); await expect(card.locator("table")).toBeVisible();
    state.status = "done"; state.footer = null;
    state.resultText = "检查完成。"; state.blocks = [{ kind: "text", content: state.resultText, streaming: false }];
    await publish(); await expect(card.getByText(state.resultText, { exact: true })).toBeVisible();
    const process = card.locator(".card-collapse");
    await expect(process).not.toHaveAttribute("open", "");
    await process.locator("summary").click(); await expect(process).toHaveAttribute("open", "");
    await process.locator("summary").click(); await expect(process).not.toHaveAttribute("open", "");
    const widths = await page.evaluate(() => (window as unknown as { streamWidths: number[] }).streamWidths);
    expect(Math.max(...widths) - Math.min(...widths)).toBeLessThan(1);
    await info.attach(`stream-widths-${palette}`, { body: JSON.stringify({ initialWidth, widths }), contentType: "application/json" });
    await page.screenshot({ path: info.outputPath(`stable-${palette}.png`) });
    // Persisted completed cards use the same width after remount, and still
    // shrink to the available column when the window gets narrower.
    await page.reload(); await setPalette(); await expect(card.getByText(state.resultText, { exact: true })).toBeVisible();
    expect((await card.boundingBox())!.width).toBeCloseTo(initialWidth, 0);
    await page.setViewportSize({ width: 800, height: 900 });
    await expect.poll(async () => (await card.boundingBox())!.width).toBeLessThan(initialWidth);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.setViewportSize({ width: 1360, height: 900 });
    await expect.poll(async () => (await card.boundingBox())!.width).toBeCloseTo(initialWidth, 0);
    const receipt = await hub.store.publishBotMessage("bot", { conversationId: chat.id, blocks: [{ type: "text", text: "名称已保存。" }] });
    const receiptCard = page.locator(`[data-message-id="${receipt.id}"] .rich-card`);
    await expect(receiptCard).toBeVisible(); expect((await receiptCard.boundingBox())!.width).toBeLessThan(initialWidth);
  } finally { await page.close(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});

test("real Hub sends small nested-card deltas and the browser preserves complete content after reload", async ({ page }, info) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "stream-browser-"));
  const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve("dist") });
  const received: HubEvent[] = [];
  page.on("websocket", (socket) => socket.on("framereceived", ({ payload }) => {
    const frame = JSON.parse(String(payload)) as { type: string };
    if (frame.type === "event") received.push(frame as HubEvent);
  }));
  try {
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','流式验收',?)", [hashSecret(randomBytes(32).toString("base64url"))]);
    const conversation = await hub.store.createConversation("owner", ["alpha"], "增量传输", "stream");
    await page.goto(hub.url); await preparePairing(page, hub); await page.getByRole("button", { name: "配对此设备", exact: true }).click();
    await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
    await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" }); await expect(page.locator(".host-workspace:not([hidden]) .connection-pill.online")).toBeVisible();
    let text = "```ts\nconst preserved = 42;\n```\n\n| 项目 | 状态 |\n| --- | --- |\n| 排版 | 保留 |\n\n" + "正文内容".repeat(12_500);
    let revision = 0;
    const blocks = (): Block[] => [{ type: "card", title: "流式协议验收", template: "blue", extra: { progress: { revision } }, elements: [{ type: "collapsible", text: "输出内容", open: true, children: [{ type: "markdown", text }] }] }];
    const initial = await hub.store.publishBotMessage("alpha", { conversationId: conversation.id, blocks: blocks(), status: "streaming" });
    await expect(page.getByText("流式协议验收", { exact: true })).toBeVisible();
    const card = page.locator(`[data-message-id="${initial.id}"] .rich-card`);
    await expect(card.locator("table")).toHaveCount(1); await expect(card.locator("pre")).toContainText("const preserved = 42;");
    await card.evaluate(node => { Object.assign(window, { originalStreamCard: node }); });
    for (let i = 1; i <= 12; i++) { revision = i; text += `\n\n新增段落 ${i}。`; await hub.store.publishBotMessage("alpha", { id: initial.id, conversationId: conversation.id, blocks: blocks(), status: "streaming" }); }
    await expect(page.getByText("新增段落 12。", { exact: true })).toBeVisible();
    const deltas = received.filter((event) => event.kind === "message.stream"); expect(deltas).toHaveLength(12);
    expect(deltas.every(event => JSON.stringify(event.payload).includes("replaceCardExtra"))).toBe(true);
    expect(await card.evaluate(node => node === (window as any).originalStreamCard)).toBe(true);
    await expect(card.locator("table")).toHaveCount(1); await expect(card.locator("pre")).toContainText("const preserved = 42;");
    const deltaBytes = deltas.reduce((sum, event) => sum + Buffer.byteLength(JSON.stringify(event)), 0);
    expect(deltaBytes).toBeLessThan(6000);
    await page.reload(); await expect(page.locator(".host-workspace:not([hidden]) .connection-pill.online")).toBeVisible();
    await expect(page.getByText("新增段落 12。", { exact: true })).toBeVisible();
    text += "\n\n最终内容保持完整。";
    const final = await hub.store.publishBotMessage("alpha", { id: initial.id, conversationId: conversation.id, blocks: blocks(), status: "complete" });
    await expect(page.getByText("最终内容保持完整。", { exact: true })).toBeVisible();
    const cached = await page.evaluate(async ({id,databaseName}) => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => { const request = indexedDB.open(databaseName); request.onsuccess = () => resolve(request.result); request.onerror = reject; });
      try { return await new Promise<Message & { activitySeq?: number; activityAt?: number }>((resolve, reject) => { const request = db.transaction("messages").objectStore("messages").get(id); request.onsuccess = () => resolve(request.result); request.onerror = reject; }); } finally { db.close(); }
    }, {id:final.id,databaseName:await singleHostCacheName(page)});
    const finalEvent = received.filter((event) => event.kind === "message.updated").at(-1)!;
    const { activitySeq, activityAt, ...message } = cached;
    expect(message).toEqual(final);
    expect(finalEvent.payload).toEqual(final);
    expect(activitySeq).toBe(finalEvent.seq);
    expect(activityAt).toBe(Math.max(finalEvent.at, final.createdAt));
    const metrics = { characters: text.length, deltas: deltas.length, deltaBytes, repeatedFullSnapshotBytes: Buffer.byteLength(JSON.stringify(initial)) * deltas.length, finalVersion: cached.version };
    console.log("Stream transport", JSON.stringify(metrics));
    await info.attach("stream-transport", { body: JSON.stringify(metrics), contentType: "application/json" });
  } finally { await page.close(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});

test("IndexedDB ignores duplicates and stale versions, rolls back gaps, and accepts a full recovery base", async ({ page }) => {
  const server = await createServer({ server: { port: 0, strictPort: false, host: "127.0.0.1" } }); await server.listen();
  try {
    await page.goto(server.resolvedUrls!.local[0] + "e2e/fixtures/stream.html");
    await page.waitForFunction(() => "streamCache" in window);
    const result = await page.evaluate(async () => {
      const cache = (window as unknown as { streamCache: ClientCache }).streamCache;
      const base: Message = { id: "message", conversationId: "conversation", authorId: "alpha", authorType: "bot", blocks: [{ type: "text", text: "start" }], status: "streaming", version: 1, createdAt: 1 };
      const full = (seq: number, message: Message): HubEvent => ({ v: 1, type: "event", conversationId: "conversation", seq, kind: "message.updated", payload: message, at: seq });
      const delta = (seq: number, baseVersion: number, version: number): HubEvent => ({ v: 1, type: "event", conversationId: "conversation", seq, kind: "message.stream", payload: { messageId: "message", baseVersion, version, ops: [{ op: "appendText", block: 0, text: " continued" }] }, at: seq });
      const failure = async (event: HubEvent) => { try { await cache.apply(event); return "accepted"; } catch (error) { return (error as Error).message; } };
      await cache.apply(full(1, base)); await cache.apply(delta(2, 1, 2)); await cache.apply(delta(2, 1, 2));
      await cache.apply(full(3, base)); await cache.apply(delta(4, 1, 2));
      const before = await cache.messages("conversation");
      const wrongBase = await failure(delta(5, 3, 4)), gap = await failure(delta(6, 2, 3));
      const afterFailure = { messages: await cache.messages("conversation"), cursors: await cache.cursors() };
      await cache.apply(full(5, { ...base, version: 3, blocks: [{ type: "text", text: "recovered" }] }));
      await cache.apply(delta(6, 3, 4));
      await cache.apply(full(7, { ...base, version: 5, status: "complete", blocks: [{ type: "text", text: "final corrected" }] }));
      await cache.apply(delta(8, 3, 4));
      const crossConversation = await failure(full(9, { ...base, version: 6, conversationId: "other" }));
      return { before, wrongBase, gap, afterFailure, crossConversation, final: await cache.messages("conversation"), cursors: await cache.cursors(), activity: await cache.activity() };
    });
    expect(result.before[0]?.blocks).toEqual([{ type: "text", text: "start continued" }]);
    expect(result.wrongBase).toBe("stream_base_mismatch"); expect(result.gap).toBe("sync_gap");
    expect(result.afterFailure).toEqual({ messages: result.before, cursors: { conversation: 4 } });
    expect(result.crossConversation).toBe("message_conversation_mismatch"); expect(result.cursors).toEqual({ conversation: 8 });
    expect(result.final[0]).toMatchObject({ version: 5, status: "complete", blocks: [{ type: "text", text: "final corrected" }] });
    expect(result.activity.conversation?.unread).toEqual({ message: 7 });
  } finally { await server.close(); }
});
