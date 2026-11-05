import { preparePairing } from "./fixtures/pairing-invite.js";
import { test, expect, type Page, type WebSocketRoute } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServer } from "./fixtures/vite.js";
import { enterMobileChat, waitForClientOnline } from "./fixtures/mobile.js";
import { HubServer } from "../../src/hub/server.js";
import { hashSecret } from "../../src/hub/auth.js";
import { attachGateway } from "../../src/gateway/service.js";
import { createCoreServiceRuntime } from "../../src/core/runtime.js";
import type { CoreBridgeLike } from "../../src/core/types.js";
import type { GatewayChannel } from "../../src/gateway/channel.js";
import { STOP_CONFIRMATION_MS } from "../src/run-stop.js";

test.use({ serviceWorkers: "block" });

for (const change of ["hide", "chat", "unmount", "double-click"] as const) test(`native stop lookup cannot outlive its target: ${change}`, async ({page}) => {
  const server=await createServer({server:{port:0,host:"127.0.0.1"}});await server.listen();
  try {
    await page.goto(server.resolvedUrls!.local[0]+"e2e/fixtures/turn-stop.html");
    await page.getByRole("button",{name:"停止",exact:true}).waitFor();
    await page.evaluate(()=>(window as any).turnStopFixture.nativeTasks());
    await page.getByRole("button",{name:"停止",exact:true}).click();
    await expect.poll(()=>page.evaluate(()=>(window as any).turnStopFixture.evidence.lookups)).toBe(1);
    if(change==="double-click") await page.getByRole("button",{name:"停止",exact:true}).click();
    else await page.evaluate(change=>{const f=(window as any).turnStopFixture;if(change==="hide")f.setVisible(false);else if(change==="chat")f.setChat("other");else f.setMounted(false);},change);
    await page.evaluate(()=>(window as any).turnStopFixture.evidence.releaseLookup());
    if(change==="double-click") {
      await expect(page.getByRole("dialog")).toContainText("原生后台检查");
      await page.getByRole("button",{name:"继续运行",exact:true}).click();
    }
    await expect.poll(()=>page.evaluate(()=>(window as any).turnStopFixture.evidence.results)).toContain(false);
    await expect(page.getByRole("dialog")).toHaveCount(0);
    expect(await page.evaluate(()=>(window as any).turnStopFixture.evidence.sent)).toEqual([]);
    expect(await page.evaluate(()=>(window as any).turnStopFixture.evidence.lookups)).toBe(1);
  }finally{await page.close();await server.close();}
});

test("native stop lookup timeout stays unverified after a late reply", async ({page}) => {
  const server=await createServer({server:{port:0,host:"127.0.0.1"}});await server.listen();
  try {
    await page.goto(server.resolvedUrls!.local[0]+"e2e/fixtures/turn-stop.html");
    await page.getByRole("button",{name:"停止",exact:true}).waitFor();
    await page.evaluate(()=>(window as any).turnStopFixture.nativeTasks());
    await page.getByRole("button",{name:"停止",exact:true}).click();
    const dialog=page.getByRole("dialog");await expect(dialog).toContainText("后台任务列表暂时无法核对");
    await page.evaluate(()=>(window as any).turnStopFixture.evidence.releaseLookup());
    await expect(dialog).not.toContainText("原生后台检查");
    await dialog.getByRole("button",{name:"继续运行",exact:true}).click();
    await expect.poll(()=>page.evaluate(()=>(window as any).turnStopFixture.evidence.results)).toEqual([false]);
    expect(await page.evaluate(()=>(window as any).turnStopFixture.evidence.sent)).toEqual([]);
  }finally{await page.close();await server.close();}
});

for (const change of ["hide", "chat", "unmount", "double-click"] as const) test(`confirmed stop is fenced during delayed cache read: ${change}`, async ({ page }) => {
  const server = await createServer({ server: { port: 0, host: "127.0.0.1" } }); await server.listen();
  try {
    await page.goto(server.resolvedUrls!.local[0] + "e2e/fixtures/turn-stop.html");
    await page.getByRole("button", { name: "停止", exact: true }).waitFor();
    const renders = await page.evaluate(() => (window as any).turnStopFixture.evidence.renders);
    await page.getByRole("textbox", { name: "草稿", exact: true }).fill("Typing must not rerender every run card in an ADHD pane");
    expect(await page.evaluate(() => (window as any).turnStopFixture.evidence.renders)).toBe(renders);
    await page.getByRole("button", { name: "停止", exact: true }).click();
    await page.getByRole("button", { name: "确认停止", exact: true }).click();
    await expect.poll(() => page.evaluate(() => (window as any).turnStopFixture.evidence.reads)).toBe(1);
    if (change === "double-click") {
      await page.getByRole("button", { name: "停止", exact: true }).click();
      await expect(page.getByRole("dialog")).toHaveCount(0);
    } else {
      await page.evaluate(change => { const fixture = (window as any).turnStopFixture; if (change === "hide") fixture.setVisible(false); else if (change === "chat") fixture.setChat("other"); else fixture.setMounted(false); }, change);
      // Commit the intervening React scope before switching back; batching both
      // changes in one frame would never hide or leave the original Workspace.
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      await page.evaluate(change => { const fixture = (window as any).turnStopFixture; if (change === "hide") fixture.setVisible(true); else if (change === "chat") fixture.setChat("chat"); }, change);
    }
    await page.evaluate(() => (window as any).turnStopFixture.evidence.release());
    await expect.poll(() => page.evaluate(() => (window as any).turnStopFixture.evidence.results.length)).toBe(change === "double-click" ? 2 : 1);
    expect(await page.evaluate(() => (window as any).turnStopFixture.evidence.sent.length)).toBe(change === "double-click" ? 1 : 0);
  } finally { await server.close(); }
});

async function pair(page: Page, url: string, hub: HubServer) {
  await page.goto(url); await page.getByRole("textbox", { name: "Hub 地址", exact: true }).fill(hub.url);
  await preparePairing(page, hub); await page.getByRole("button", { name: "配对此设备", exact: true }).click();
  await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
  await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" }); await waitForClientOnline(page);
}

type Task = { input: Parameters<CoreBridgeLike["handleAuthorizedMessage"]>[0]; finish: () => void };

test("a run card recovers from a failed, lost or unfinished stop without resending it to the next task", async ({ page }) => {
  test.setTimeout(120_000);
  const root = await mkdtemp(path.join(os.tmpdir(), "run-stop-recovery-")), stateDir = path.join(root, "bot"); await mkdir(stateDir);
  await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ engine: "codex", locale: "zh" }));
  const server = await createServer({ server: { port: 0, host: "127.0.0.1" } }); await server.listen();
  const url = server.resolvedUrls!.local[0]!;
  const hub = await HubServer.start({ stateDir: path.join(root, "hub"), origins: [new URL(url).origin] });
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  const tasks: Task[] = [], botStops: unknown[] = [], sentStops: Array<{ conversationId: string; botId?: string }> = [];
  let failStop = false, dropStop = false, gateway: GatewayChannel | undefined;
  let socket: { page: WebSocketRoute; hub: WebSocketRoute } | undefined;
  // Observe the App's own frames. A dropped turn.stop models a request lost in
  // transit: neither the run's phase nor stop_incomplete will ever answer it.
  await page.routeWebSocket("**/ws", ws => {
    const upstream = ws.connectToServer(); socket = { page: ws, hub: upstream };
    ws.onMessage(message => {
      if (typeof message === "string" && message.includes('"turn.stop"')) { sentStops.push(JSON.parse(message)); if (dropStop) return; }
      upstream.send(message);
    });
  });
  const reconnect = async () => { const current = socket!; current.page.close(); current.hub.close(); await expect.poll(() => socket !== current).toBe(true); await waitForClientOnline(page); };
  try {
    const secret = randomBytes(32).toString("base64url");
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash,engine) VALUES('alpha','停止验收助手',?,'codex')", [hashSecret(secret)]);
    const chat = await hub.store.createConversation("owner", ["alpha"], "停止恢复", "direct");
    gateway = await attachGateway({ stateDir, url: hub.instanceUrl.replace("http", "ws") + "/instance", secret, botId: "alpha", engine: "codex", runtime: createCoreServiceRuntime(), bridge: {
      // This engine ignores cancellation until the test releases it.
      handleAuthorizedMessage: async input => {
        let finish!: () => void; const released = new Promise<void>(resolve => { finish = resolve; });
        tasks.push({ input, finish });
        await input.onEngineEvent?.({ type: "tool_use", toolName: "commandExecution", toolUseId: `slow-${tasks.length}`, toolInput: { description: `执行慢速任务 ${tasks.length}` } });
        await released;
        if (input.abortSignal?.aborted) throw new Error("Stopped by user");
        return { text: `任务 ${tasks.length} 已完成` };
      },
    } });
    const handle = gateway.onCall!;
    gateway.onCall = async (method, params) => {
      if (method !== "stop") return handle(method, params);
      botStops.push(params);
      if (failStop) { failStop = false; throw new Error("stop fixture failure"); } // The Hub reports stop_incomplete.
      return handle(method, params);
    };
    await pair(page, url, hub); await enterMobileChat(page, chat.title);
    const composer = page.getByRole("textbox", { name: "消息", exact: true });
    await composer.fill("第一个任务"); await page.getByRole("button", { name: "发送消息", exact: true }).click();
    await expect.poll(() => tasks.length).toBe(1);
    const card = page.locator(".native-run").last(), stop = card.locator(".run-stop");
    const notice = card.getByText("尚未收到停止确认。请核对运行状态，需要时可再次停止。", { exact: true });
    await expect(card).toContainText("执行慢速任务 1"); await expect(stop).toHaveText("停止"); await expect(stop).toBeEnabled();

    // stop_incomplete carries no run or Bot ID. Without a request from this
    // card, another stop's failure neither changes nor blames it.
    socket!.page.send(JSON.stringify({ v: 1, type: "error", code: "stop_incomplete", message: "stop_incomplete", retryable: true }));
    await expect(page.getByText("未能确认所有 Bot 已停止，请检查运行状态。")).toBeVisible();
    await expect(stop).toBeEnabled(); await expect(notice).toHaveCount(0);
    await page.getByRole("button", { name: "关闭提示", exact: true }).click();

    // 1. The Bot cannot be reached: the card offers a manual retry at once.
    failStop = true; await stop.click();
    await expect(stop).toHaveText("停止"); await expect(stop).toBeEnabled(); await expect(notice).toBeVisible();
    await expect(card).not.toContainText("此 Bot");
    expect(sentStops).toEqual([expect.objectContaining({ type: "turn.stop", conversationId: chat.id, botId: "alpha" })]);
    expect(botStops).toHaveLength(1); expect(tasks[0]!.input.abortSignal?.aborted).toBe(false);
    await page.getByRole("button", { name: "关闭提示", exact: true }).click();

    // 2. The request is lost in transit, then the socket is replaced. The card
    // stops waiting, and reconnecting never replays the stop.
    dropStop = true; await stop.click();
    await expect(stop).toHaveText("等待停止确认"); await expect(stop).toBeDisabled(); await expect(notice).toHaveCount(0);
    dropStop = false; await reconnect();
    await expect(stop).toHaveText("停止"); await expect(stop).toBeEnabled(); await expect(notice).toBeVisible();
    await page.waitForTimeout(1000);
    expect(sentStops).toHaveLength(2); expect(botStops).toHaveLength(1); expect(tasks[0]!.input.abortSignal?.aborted).toBe(false);

    // 3. The host receives the stop and the run reports "stopping", but the
    // engine never finishes cancelling. That phase must not lock the card.
    await stop.click();
    await expect.poll(() => tasks[0]!.input.abortSignal?.aborted).toBe(true);
    await expect(card.locator(".native-run-status")).toContainText("正在停止");
    await expect(stop).toHaveText("等待停止确认"); await expect(stop).toBeDisabled(); await expect(notice).toHaveCount(0);
    const waitingSince = Date.now();
    // The run's own phase outranks an unattributed failure from elsewhere.
    socket!.page.send(JSON.stringify({ v: 1, type: "error", code: "stop_incomplete", message: "stop_incomplete", retryable: true }));
    await page.waitForTimeout(1000); await expect(stop).toBeDisabled();
    await expect(stop).toBeEnabled({ timeout: STOP_CONFIRMATION_MS + 5000 });
    expect(Date.now() - waitingSince).toBeGreaterThan(STOP_CONFIRMATION_MS - 2000);
    await expect(stop).toHaveText("停止"); await expect(notice).toBeVisible();
    await expect(card.locator(".native-run-status")).toContainText("正在停止");
    expect(botStops).toHaveLength(2); expect(sentStops).toHaveLength(3);
    // A retry is another explicit click for this card's conversation and Bot.
    await stop.click(); await expect(stop).toHaveText("等待停止确认");
    await expect.poll(() => botStops.length).toBe(3);
    expect(sentStops.at(-1)).toMatchObject({ conversationId: chat.id, botId: "alpha" });
    tasks[0]!.finish(); await expect(card.locator(".native-run-status")).toContainText("已停止");
    await expect(card.locator(".run-stop")).toHaveCount(0); await expect(notice).toHaveCount(0);

    // The next task is never stopped by an earlier request or a reconnect.
    await composer.fill("第二个任务"); await page.getByRole("button", { name: "发送消息", exact: true }).click();
    await expect.poll(() => tasks.length).toBe(2);
    const next = page.locator(".native-run").last(); await expect(next).toContainText("执行慢速任务 2");
    await expect(next.locator(".run-stop")).toHaveText("停止"); await expect(next.locator(".run-stop")).toBeEnabled();
    await reconnect(); await page.waitForTimeout(1000);
    expect(tasks[1]!.input.abortSignal?.aborted).toBe(false); expect(sentStops).toHaveLength(4); expect(botStops).toHaveLength(3);
    await expect(next.getByText("尚未收到停止确认。请核对运行状态，需要时可再次停止。", { exact: true })).toHaveCount(0);
    tasks[1]!.finish(); await expect(next.locator(".native-run-status")).toContainText("已完成");
    await expect(next).toContainText("任务 2 已完成");
    expect(errors).toEqual([]);
  } finally {
    for (const task of tasks) task.finish();
    await gateway?.disconnect(); await hub.close(); await server.close(); await rm(root, { recursive: true, force: true });
  }
});

for (const layout of ["phone", "adhd"] as const) test(`${layout} Claude stop explains shared background impact and fences the original reply`, async ({ page }, info) => {
  test.setTimeout(90000);
  await page.setViewportSize({ width: layout === "phone" ? 390 : 1440, height: 900 });
  const root = await mkdtemp(path.join(os.tmpdir(), "stop-impact-")), stateDir = path.join(root, "bot"); await mkdir(stateDir);
  await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ engine: "claude", locale: "zh" }));
  const server = await createServer({ server: { port: 0, host: "127.0.0.1" } }); await server.listen();
  const url = server.resolvedUrls!.local[0]!, hub = await HubServer.start({ stateDir: path.join(root, "hub"), origins: [new URL(url).origin] });
  const tasks: Task[] = [], stops: unknown[] = [];
  await page.routeWebSocket("**/ws", ws => { const upstream = ws.connectToServer(); ws.onMessage(message => { if (typeof message === "string" && message.includes('"turn.stop"')) stops.push(JSON.parse(message)); upstream.send(message); }); });
  const secret = randomBytes(32).toString("base64url");
  await hub.store.db.run("INSERT INTO bots(id,name,secret_hash,engine) VALUES('alpha','Claude',?,'claude')", [hashSecret(secret)]);
  const chat = await hub.store.createConversation("owner", ["alpha"], "并行任务", "stop-impact");
  const gateway = await attachGateway({ stateDir, url: hub.instanceUrl.replace("http", "ws") + "/instance", secret, botId: "alpha", engine: "claude", runtime: createCoreServiceRuntime(), bridge: { handleAuthorizedMessage: async input => {
    let finish!: () => void; const pending = new Promise<void>(resolve => { finish = resolve; }); tasks.push({ input, finish });
    await input.onEngineEvent?.({ type: "tool_use", toolName: "Read", toolUseId: `read-${tasks.length}` });
    input.abortSignal?.addEventListener("abort", finish, { once: true }); await pending;
    if (input.abortSignal?.aborted) throw new Error("Task was stopped by user"); return { text: "已完成" };
  } } });
  try {
    await pair(page, url, hub); await enterMobileChat(page, chat.title);
    if (layout === "adhd") { await page.getByRole("button", { name: "打开 ADHD 模式", exact: true }).click(); await page.getByRole("checkbox", { name: /加入面板：.*并行任务$/ }).check(); }
    const composer = page.locator(".composer textarea");
    await composer.fill("第一轮"); await page.locator(".send-button").click(); await expect.poll(() => tasks.length).toBe(1);
    const start = Date.now();
    await hub.store.publishBotMessage("alpha", { conversationId: chat.id, blocks: [{ type: "card", elements: [{ type: "markdown", text: "后台任务执行中" }, { type: "markdown", text: "核对中" }], extra: { scopedRun: { version: 1, id: "parallel", revision: 1, phase: "working", startedAt: start, updatedAt: start, count: 0, completed: 0, failed: 0, truncated: false } } }] });
    await expect(page.locator(".native-run.is-scoped")).toBeVisible();
    const warning = page.getByRole("dialog", { name: "停止当前消息？", exact: true });
    const foreground = page.locator(".native-run:not(.is-scoped)").last();
    await foreground.locator(".run-stop").click(); await expect(warning).toContainText("也会中断");
    await expect.poll(() => warning.evaluate(node => { const rect = node.getBoundingClientRect(); return rect.top >= 0 && rect.bottom <= innerHeight + 1; })).toBe(true);
    await page.screenshot({ path: info.outputPath(`stop-impact-${layout}.png`) });
    expect(stops).toHaveLength(0); await warning.getByRole("button", { name: "继续运行", exact: true }).click();
    await expect(warning).toHaveCount(0); expect(tasks[0].input.abortSignal?.aborted).toBe(false);
    await page.locator(".composer-stop").click(); await expect(warning).toBeVisible();
    // Completion while deciding must withdraw consent instead of targeting the next reply.
    tasks[0].finish(); await expect(warning).toHaveCount(0); expect(stops).toHaveLength(0);
    await composer.fill("第二轮"); await page.locator(".send-button").click(); await expect.poll(() => tasks.length).toBe(2);
    await page.locator(".composer-stop").click(); await expect(warning).toBeVisible();
    await warning.getByRole("button", { name: "确认停止", exact: true }).click();
    await expect.poll(() => stops.length).toBe(1); await expect.poll(() => tasks[1].input.abortSignal?.aborted).toBe(true);
    await expect(page.locator(".composer-stop")).toHaveCount(0);
    // A wait can finish before its stop arrives. Explain both outcomes rather than promising a client-side wait-only cancel.
    await composer.fill("等待复审"); await page.locator(".send-button").click(); await expect.poll(() => tasks.length).toBe(3);
    await tasks[2].input.onEngineEvent?.({ type: "background_review_wait", status: "started" });
    const waiting = page.locator(".native-run:not(.is-scoped)").last();
    await expect(waiting.locator(".native-run-status")).toContainText("等待后台结果处理");
    await waiting.getByRole("button", { name: "取消等待", exact: true }).click();
    await expect(warning).toContainText("只取消等待"); expect(stops).toHaveLength(1);
    await warning.getByRole("button", { name: "确认停止", exact: true }).click();
    await expect(warning).toHaveCount(0); await expect.poll(() => stops.length).toBe(2);
  } finally { for (const task of tasks) task.finish(); await page.close(); await gateway.disconnect(); await hub.close(); await server.close(); await rm(root, { recursive: true, force: true }); }
});
