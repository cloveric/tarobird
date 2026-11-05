import { preparePairing } from "./fixtures/pairing-invite.js";
import { clickAppAction } from "./fixtures/desktop-actions.js";
import { test, expect, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { HubServer } from "../../src/hub/server.js";
import { blocksText, type Block } from "../../src/client-protocol/index.js";
import { archiveAcceptanceThreads } from "../../tests/helpers/codex-acceptance.js";
import { selectConversation, waitForClientOnline } from "./fixtures/mobile.js";

type Observation = { at: number; type: string; method?: string; ok?: boolean; cleared?: boolean; goalPresent?: boolean; goalStatus?: string; status?: string; threadId?: string; turnId?: string; sourceRpcId?: string; outcome?: string; source?: { rpcId?: string }; items?: Array<{ id: string; sourceRpcId?: string }> };
// Exclude the static objective banner as well as thinking/tool panels. The
// banner repeats user text before any native worker has even started.
const answerText = (blocks: Block[]) => blocks.flatMap((b) => b.type === "text" ? [b.text] : b.type === "card" ? b.elements.flatMap((e) => e.type === "markdown" && !/^🎯 \*\*(?:目标|Goal):/.test(e.text) ? [e.text] : []) : []).join("\n");
const jsonl = async <T,>(file: string): Promise<T[]> => (await readFile(file, "utf8").catch((e: NodeJS.ErrnoException) => { if (e.code === "ENOENT") return ""; throw e; })).split("\n").filter(Boolean).map((line) => JSON.parse(line));
async function pair(page: Page, hub: HubServer) {
  await page.goto(hub.url); await preparePairing(page, hub); await page.getByRole("button", { name: "配对此设备", exact: true }).click();
  await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
  await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" }); await waitForClientOnline(page);
}

test.use({ actionTimeout: 15_000 });
const flow = process.env.TAROCUB_LIVE_GOAL_FLOW || "stop";
for (const engine of ["codex", "deepseek"] as const) test(`real ${engine} autonomous goal ${flow} preserves output and ordinary chat continuity`, async ({ page, browser }, info) => {
  test.skip(process.env.TAROCUB_LIVE_GOAL !== "1" || !!process.env.TAROCUB_LIVE_ENGINE && process.env.TAROCUB_LIVE_ENGINE !== engine, "explicit native goal acceptance only");
  test.setTimeout(240_000);
  expect(["stop", "complete", "queued-stop"]).toContain(flow);
  test.skip(flow === "queued-stop" && engine !== "deepseek", "DeepSeek exact queued cancellation acceptance");
  const version = execFileSync(engine === "codex" ? process.env.CODEX_EXECUTABLE || "codex" : process.env.DSH_EXECUTABLE || "dsh", ["--version"], { encoding: "utf8" }).trim();
  const root = await mkdtemp(path.join(os.tmpdir(), "live-client-worker-")), workspace = path.join(root, "workspace"); await mkdir(workspace);
  const entrypoint = path.resolve("../dist/src/index.js"), log = path.join(root, "goal-observer.jsonl");
  const env = { ...process.env, TAROCUB_GOAL_WORKER_ENTRY: entrypoint, TAROCUB_GOAL_OBSERVER_LOG: log,
    TAROCUB_GOAL_PROTOCOL_MODULE: pathToFileURL(path.resolve("../dist/src/codex/deepseek-harness-protocol.js")).href,
    NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import=${pathToFileURL(path.resolve("e2e/fixtures/goal-observer.mjs")).href}` };
  const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve("dist"), managedBots: { entrypoint, env } });
  const phoneContext = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }), phone = await phoneContext.newPage();
  const observations = () => jsonl<Observation>(log);
  const nativeIds = new Set<string>(); let receipt: Record<string, unknown> | undefined;
  try {
    await pair(page, hub); await clickAppAction(page, "新建 Bot", page.getByRole("button", { name: "新建 Bot", exact: true }));
    await page.getByLabel("Bot 名称", { exact: true }).fill(`${engine} 目标验收`);
    await page.getByLabel("引擎", { exact: true }).selectOption(engine);
    await page.getByLabel("模型", { exact: true }).selectOption(engine === "codex" ? "gpt-6-astra" : "");
    await page.getByLabel("推理强度（effort）").selectOption("low");
    await page.getByText("高级设置", { exact: true }).click(); await page.getByLabel("工作区（可选）", { exact: true }).fill(workspace);
    await page.getByRole("button", { name: "创建 Bot", exact: true }).click();
    await expect(page.getByText("Bot 已上线，可以开始对话。", { exact: true })).toBeVisible({ timeout: 30_000 });
    await page.getByRole("button", { name: "开始对话", exact: true }).click(); await pair(phone, hub);
    const bot = (await hub.store.bots("owner"))[0]!, conversation = (await hub.store.conversations("owner"))[0]!;
    await selectConversation(phone, conversation.title);
    const snapshot = () => hub.store.snapshot("owner", conversation.id);
    const session = async () => {
      const state = JSON.parse(await readFile(path.join(root, "bots", bot.id, "session.json"), "utf8"));
      const id = state.chats.find((c: { conversationKey: string }) => c.conversationKey === `lark:${conversation.id}`)?.codexSessionId as string | undefined;
      if (id) nativeIds.add(id); return id;
    };
    const send = async (text: string, device = page) => {
      await device.getByRole("textbox", { name: "消息", exact: true }).fill(text);
      await device.getByRole("button", { name: "发送消息", exact: true }).click();
      const accepted = async () => (await snapshot()).messages.find((m) => m.authorType === "user" && blocksText(m.blocks) === text);
      await expect.poll(accepted).toBeTruthy(); return (await accepted())!;
    };
    if (flow === "complete") {
      const a = 1000 + randomBytes(2).readUInt16BE(), b = 1000 + randomBytes(2).readUInt16BE(), expected = `SUM:${a + b}`;
      const input = await send(`/goal --budget 80000 计算 ${a} 加 ${b}。在对话中给出最终结果，格式为 SUM: 后接计算结果，不要其他说明。不要运行终端、读取或写入文件、发送外部消息。完成后标记目标已完成。`, phone);
      const result = async () => (await snapshot()).messages.find((m) => m.authorType === "bot" && m.replyTo === input.id && m.status === "complete");
      await expect.poll(result, { timeout: 90_000 }).toBeTruthy();
      const sessionId = await session();
      expect(answerText((await result())!.blocks).match(new RegExp(`SUM:\\s*${a + b}\\b`, "g"))).toHaveLength(1);
      const status = await send("/goal status", phone);
      await expect.poll(async () => (await snapshot()).messages.some((m) => m.replyTo === status.id && answerText(m.blocks).includes("当前聊天没有活跃 goal")), { timeout: 15_000 }).toBe(true);
      expect(await session()).toBe(sessionId);
      for (const [device, label] of [[page, "desktop"], [phone, "phone"]] as const) {
        await device.reload(); await waitForClientOnline(device); await selectConversation(device, conversation.title);
        await expect(device.locator(`[data-message-id="${(await result())!.id}"]`)).toContainText(new RegExp(`SUM:\\s*${a + b}\\b`));
        await expect(device.locator(".markdown-pending")).toHaveCount(0);
        await device.screenshot({ path: info.outputPath(`goal-${engine}-${label}.png`) });
      }
      receipt = { engine, version, flow, finalComputedAnswerVisible: expected, bothClientsReloaded: true,
        nativeGoalAbsentAfterCompletion: true, sameNativeSession: true, physicalDevices: false, native: await observations() };
      return;
    }
    const theme = `蓝色书屋-${randomBytes(3).toString("hex")}`;
    const input = await send(`/goal --budget 80000 写一篇约 6000 汉字的温暖科幻短篇，主题是海边修理风车的工程师，完整标题是「${theme}」。直接输出标题和故事正文，保留作品编号；不要先解释计划。只在对话中写作，不要读取或写入文件、运行终端或发送外部消息。写完后完成目标。`);
    const streaming = async () => (await snapshot()).messages.find((m) => m.authorType === "bot" && m.replyTo === input.id && m.status === "streaming" && answerText(m.blocks).includes(theme));
    await expect.poll(streaming, { timeout: 90_000, intervals: [50] }).toBeTruthy();
    const run = (await streaming())!; const originalSession = await session(); expect(originalSession).toBeTruthy();
    const autonomous = (await observations()).find((o) => ["turn/started", "turn/start"].includes(o.type));
    expect(autonomous).toBeTruthy();
    expect((await observations()).some((o) => o.type === "response" && o.ok && o.method === (engine === "codex" ? "thread/goal/set" : "goal.create"))).toBe(true);
    expect((await observations()).filter((o) => o.type === "request" && ["turn/start", "session.prompt"].includes(o.method!))).toHaveLength(0);
    if (flow === "queued-stop") {
      const queued = await send(`不要执行这条即将撤回的排队消息。只回复 WITHDRAWN-${randomBytes(4).toString("hex")}`, phone);
      const nativePrompt = async () => (await observations()).find((o) => o.type === "request" && o.method === "session.prompt");
      await expect.poll(nativePrompt).toBeTruthy();
      const requestId = (await nativePrompt())!.sourceRpcId; expect(requestId).toBeTruthy();
      await expect.poll(async () => (await observations()).some((o) => o.type === "inbox" && o.items?.some((item) => item.sourceRpcId === requestId)), { timeout: 15_000 }).toBe(true);
      const ordinaryCard = async () => (await snapshot()).messages.find((m) => m.authorType === "bot" && m.replyTo === queued.id);
      await expect.poll(ordinaryCard).toBeTruthy();
      // Explicit steering must never target the goal that is holding this
      // ordinary input in the native inbox.
      await phone.getByRole("textbox", { name: "消息", exact: true }).fill("STEER-QUEUED-CANARY 不要改变正在执行的目标。");
      await clickAppAction(phone, "引导当前任务", phone.getByRole("button", { name: "引导当前任务", exact: true }));
      for (const device of [page, phone]) await expect(device.locator(".steering-receipt.rejected")).toContainText("这条消息仍在排队");
      expect((await snapshot()).messages.flatMap((m) => m.blocks).filter((b) => b.type === "steering")).toContainEqual(expect.objectContaining({ outcome: "rejected", reason: "queued" }));
      expect((await observations()).filter((o) => o.type === "exact-steer-request")).toHaveLength(0);
      await phone.getByRole("textbox", { name: "消息", exact: true }).fill("");
      const stopAt = Date.now(); await clickAppAction(phone, "停止当前轮次", phone.getByRole("button", { name: "停止当前轮次", exact: true }));
      const stopReceipt = async () => (await observations()).find((o) => o.type === "exact-stop-result" && o.sourceRpcId === requestId);
      await expect.poll(stopReceipt).toMatchObject({ outcome: "removed" });
      for (const device of [page, phone]) await expect(device.locator(`[data-message-id="${(await ordinaryCard())!.id}"]`)).toContainText("已停止", { timeout: 15_000 });
      const before = answerText((await hub.store.messageForBot(bot.id, run.id)).blocks).length;
      await expect.poll(async () => answerText((await hub.store.messageForBot(bot.id, run.id)).blocks).length, { timeout: 25_000 }).toBeGreaterThan(before + 20);
      expect((await hub.store.messageForBot(bot.id, run.id)).status).toBe("streaming");
      expect((await observations()).filter((o) => o.at >= stopAt && o.type === "request" && ["goal.clear", "session.cancel"].includes(o.method!))).toHaveLength(0);
      expect((await observations()).some((o) => o.type === "user/message" && o.source?.rpcId === requestId)).toBe(false);
      for (const [device, label] of [[page, "desktop"], [phone, "phone"]] as const) {
        await expect(device.locator(`[data-message-id="${run.id}"]`)).toContainText(theme);
        await device.screenshot({ path: info.outputPath(`goal-${engine}-${label}.png`) });
      }
      // Now stop the goal itself, then prove the withdrawn prompt cannot run
      // after the active round releases the native inbox.
      const goalStopAt = Date.now(); await clickAppAction(phone, "停止当前轮次", phone.getByRole("button", { name: "停止当前轮次", exact: true }));
      await expect.poll(async () => (await observations()).some((o) => o.at >= goalStopAt && o.type === "turn/end" && o.turnId === autonomous?.turnId && o.status === "aborted"), { timeout: 15_000 }).toBe(true);
      const ordinaryTitle = `星海书信-${randomBytes(3).toString("hex")}`;
      const activeInput = await send(`在对话里写约 4000 汉字的温暖科幻故事，完整标题是「${ordinaryTitle}」。直接输出标题和正文，不要运行终端、使用工具、读写文件。`, phone);
      await expect.poll(async () => (await snapshot()).messages.some((m) => m.replyTo === activeInput.id && m.authorType === "bot" && m.status === "streaming" && answerText(m.blocks).includes(ordinaryTitle)), { timeout: 90_000 }).toBe(true);
      const activePrompt = (await observations()).filter((o) => o.type === "request" && o.method === "session.prompt").at(-1)!;
      const activeTurn = (await observations()).filter((o) => o.type === "turn/start").at(-1)!;
      const activeStopAt = Date.now(); await clickAppAction(phone, "停止当前轮次", phone.getByRole("button", { name: "停止当前轮次", exact: true }));
      await expect.poll(async () => (await observations()).find((o) => o.type === "exact-stop-result" && o.sourceRpcId === activePrompt.sourceRpcId)).toMatchObject({ outcome: "cancelled" });
      await expect.poll(async () => (await observations()).some((o) => o.at >= activeStopAt && o.type === "turn/end" && o.turnId === activeTurn.turnId && o.status === "aborted"), { timeout: 15_000 }).toBe(true);
      const follow = await send("不要调用工具。只回复 QUEUE-CLEAR-OK。", phone);
      const reply = async () => (await snapshot()).messages.find((m) => m.replyTo === follow.id && m.authorType === "bot" && m.status === "complete" && answerText(m.blocks).includes("QUEUE-CLEAR-OK"));
      await expect.poll(reply, { timeout: 90_000 }).toBeTruthy();
      expect(await session()).toBe(originalSession);
      expect((await observations()).some((o) => o.type === "user/message" && o.source?.rpcId === requestId)).toBe(false);
      for (const device of [page, phone]) { await device.reload(); await waitForClientOnline(device); await selectConversation(device, conversation.title); await expect(device.locator(`[data-message-id="${(await reply())!.id}"]`)).toContainText("QUEUE-CLEAR-OK"); }
      receipt = { engine, version, flow, nativeQueuedIdentity: requestId, stopReceipt: await stopReceipt(), queuedPromptNeverConsumed: true,
        queuedSteeringRejectedOnBothClients: true, noNativeSteeringIntoGoal: true,
        nativeGoalContinuedAfterWithdrawal: true, noGlobalCancelDuringWithdrawal: true, sameNativeSession: true,
        activeOrdinaryCancelledByIdentity: true, subsequentOrdinaryReply: true, bothClientsReloaded: true, physicalDevices: false, native: await observations() };
      return;
    }
    const stopAt = Date.now(); await clickAppAction(phone, "停止当前轮次", phone.getByRole("button", { name: "停止当前轮次", exact: true }));
    for (const device of [page, phone]) await expect(device.locator(`[data-message-id="${run.id}"]`)).toContainText("已停止", { timeout: 15_000 });
    const clear = async () => (await observations()).find((o) => o.at >= stopAt && o.type === "response" && o.method === (engine === "codex" ? "thread/goal/clear" : "goal.clear") && o.ok && o.cleared);
    await expect.poll(clear).toBeTruthy();
    // UI interruption alone does not prove native work stopped. Codex exposes
    // the exact terminal turn event; DeepSeek exposes its cancel RPC receipt.
    const nativeStop = async () => (await observations()).find((o) => o.at >= stopAt && (engine === "codex"
      ? o.type === "turn/completed" && o.turnId === autonomous?.turnId && o.status === "interrupted"
      : o.type === "turn/end" && o.turnId === autonomous?.turnId && o.status === "aborted"));
    await expect.poll(nativeStop, { timeout: 15_000 }).toBeTruthy();
    const stoppedVersion = (await hub.store.messageForBot(bot.id, run.id)).version;
    const follow = await send("不要调用工具或读取文件。刚才指定的完整故事标题是什么？只用一行回复：续聊：加上完整标题，保留作品编号。", phone);
    const reply = async () => (await snapshot()).messages.find((m) => m.authorType === "bot" && m.replyTo === follow.id && m.status === "complete"
      && answerText(m.blocks).includes("续聊：") && answerText(m.blocks).includes(theme));
    await expect.poll(reply, { timeout: 90_000 }).toBeTruthy();
    expect(await session()).toBe(originalSession); expect((await hub.store.messageForBot(bot.id, run.id)).version).toBe(stoppedVersion);
    const status = await send("/goal status", phone);
    await expect.poll(async () => (await snapshot()).messages.some((m) => m.replyTo === status.id && answerText(m.blocks).includes("当前聊天没有活跃 goal")), { timeout: 15_000 }).toBe(true);
    for (const [device, label] of [[page, "desktop"], [phone, "phone"]] as const) {
      await device.reload(); await waitForClientOnline(device); await selectConversation(device, conversation.title);
      await expect(device.locator(`[data-message-id="${(await reply())!.id}"]`)).toContainText(theme);
      await expect(device.locator(".markdown-pending")).toHaveCount(0);
      await device.screenshot({ path: info.outputPath(`goal-${engine}-${label}.png`) });
    }
    receipt = { engine, version, flow, nativeGoalStarted: true, noSyntheticTurnStart: true, realAnswerBeforeStop: true,
      nativeClearAcknowledged: true, nativeStop: await nativeStop(), nativeStopOffsetMs: (await nativeStop())!.at - stopAt,
      sameNativeSession: true, ordinaryFollowupRemembersTitle: true, nativeGoalAbsentAfterStop: true,
      stoppedMessageUnchanged: true, bothClientsReloaded: true, physicalDevices: false, native: await observations() };
  } catch (error) {
    await writeFile(info.outputPath(`goal-${engine}-diagnostics.json`), JSON.stringify({ native: await observations(),
      conversations: await Promise.all((await hub.store.conversations("owner")).map(async (c) => ({ messages: (await hub.store.snapshot("owner", c.id)).messages.map((m) => ({ id: m.id, replyTo: m.replyTo, status: m.status, answer: answerText(m.blocks) })) }))) }, null, 2));
    throw error;
  } finally {
    await phoneContext.close(); await page.close(); await hub.close();
    if (engine === "codex") await archiveAcceptanceThreads(root, undefined, [...nativeIds]);
    if (receipt) await writeFile(info.outputPath(`goal-${engine}.json`), JSON.stringify({ ...receipt, ownedWorkersStopped: true, ownedCodexThreadsArchived: engine === "codex" }, null, 2));
    await rm(root, { recursive: true, force: true });
  }
});
