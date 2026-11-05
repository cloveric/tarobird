import { preparePairing } from "./fixtures/pairing-invite.js";
import { clickAppAction } from "./fixtures/desktop-actions.js";
import { selectConversation, waitForClientOnline } from "./fixtures/mobile.js";
import { test, expect, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { HubServer } from "../../src/hub/server.js";
import { HubPromptQueue } from "../../src/hub/prompt-queue.js";
import { blocksText, type Block } from "../../src/client-protocol/index.js";
import { archiveAcceptanceThreads } from "../../tests/helpers/codex-acceptance.js";
import { ownClaudeFixtureTranscripts } from "./fixtures/claude-app-observer.js";

const definitions = [
  { engine: "codex", model: "gpt-6-astra", executable: process.env.CODEX_EXECUTABLE || "codex" },
  { engine: "claude", model: "sonnet", executable: process.env.CLAUDE_EXECUTABLE || "claude" },
  { engine: "kimi", model: "", executable: process.env.KIMI_EXECUTABLE || path.join(os.homedir(), ".kimi-code/bin/kimi") },
  { engine: "deepseek", model: "", executable: process.env.DSH_EXECUTABLE || "dsh" },
  { engine: "antigravity", model: "", executable: process.env.ANTIGRAVITY_EXECUTABLE || "agy" },
] as const;
type Observation = { at: number; type: string; pid?: number; executable?: string; sessionId?: string; method?: string; ok?: boolean; status?: string; stopReason?: string; signal?: string };
// Exclude summaries and collapsible thinking/tool panels: a model can mention
// the sentinel while reasoning before it has emitted any answer text.
function answerText(blocks: Block[]): string {
  return blocks.map((block) => block.type === "text" ? block.text : block.type === "card"
    ? block.elements.filter((element) => element.type === "markdown").map((element) => element.text ?? "").join("\n") : "").join("\n");
}
async function jsonl<T>(file: string): Promise<T[]> {
  return (await readFile(file, "utf8").catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return ""; throw error; })).split("\n").filter(Boolean).flatMap((line) => { try { return [JSON.parse(line) as T]; } catch { return []; } });
}
async function pair(page: Page, hub: HubServer) {
  await page.goto(hub.url); await preparePairing(page, hub); await page.getByRole("button", { name: "配对此设备", exact: true }).click();
  await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
  await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" }); await waitForClientOnline(page);
}
test.use({ actionTimeout: 15_000 });
for (const definition of definitions) test(`real ${definition.engine} phone stop settles native work and preserves the session`, async ({ page, browser }, info) => {
  test.skip(process.env.TAROCUB_LIVE_STOP !== "1" || !!process.env.TAROCUB_LIVE_ENGINE && process.env.TAROCUB_LIVE_ENGINE !== definition.engine, "explicit live-engine acceptance only");
  test.setTimeout(240_000);
  const { engine, model, executable } = definition;
  const followupMode = process.env.TAROCUB_LIVE_STOP_FLOW ?? "after-native";
  expect(["after-native", "immediate", "queued"]).toContain(followupMode);
  // Optional reproduction of the original early-reasoning stop. Default
  // acceptance requires a real answer and never counts thinking as that answer.
  const allowReasoningMarker = process.env.TAROCUB_STOP_REASONING_REPRO === "1";
  const stopText = allowReasoningMarker ? blocksText : answerText;
  const version = execFileSync(executable, ["--version"], { encoding: "utf8" }).trim();
  const root = await mkdtemp(path.join(os.tmpdir(), engine === "claude" ? "live-claude-app-tools-" : "live-client-worker-"));
  const workspace = path.join(root, "workspace"); await mkdir(workspace);
  const cleanupClaude = engine === "claude" ? await ownClaudeFixtureTranscripts(workspace) : undefined;
  const nativeLog = path.join(root, "native-stop.jsonl"), entrypoint = path.resolve("../dist/src/index.js");
  const env = { ...process.env, TAROCUB_STOP_WORKER_ENTRY: entrypoint, TAROCUB_STOP_OBSERVER_LOG: nativeLog,
    TAROCUB_STOP_PROTOCOL_MODULE: pathToFileURL(path.resolve("../dist/src/codex/deepseek-harness-protocol.js")).href,
    NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import=${pathToFileURL(path.resolve("e2e/fixtures/stop-observer.mjs")).href}` };
  if (engine === "kimi") {
    const home = path.join(root, "kimi-home"), nativeHome = process.env.KIMI_CODE_HOME ?? path.join(os.homedir(), ".kimi-code");
    await mkdir(path.join(home, "workspace-trust"), { recursive: true, mode: 0o700 });
    await symlink(path.join(nativeHome, "config.toml"), path.join(home, "config.toml"));
    await symlink(path.join(nativeHome, "credentials"), path.join(home, "credentials"), "dir");
    const trustKey = `wd_workspace_${createHash("sha256").update(workspace).digest("hex").slice(0, 12)}`;
    await writeFile(path.join(home, "workspace-trust", trustKey), JSON.stringify({ root: workspace, trustedAt: Date.now() }), { mode: 0o600, flag: "wx" });
    Object.assign(env, { KIMI_CODE_HOME: home });
  }
  const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve("dist"), managedBots: { entrypoint, env } });
  const phoneContext = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }), phone = await phoneContext.newPage();
  let receipt: Record<string, unknown> | undefined;
  try {
    await pair(page, hub); await clickAppAction(page, "新建 Bot", page.getByRole("button", { name: "新建 Bot", exact: true }));
    await page.getByLabel("Bot 名称", { exact: true }).fill(`${engine} 停止验收`);
    await page.getByLabel("引擎", { exact: true }).selectOption(engine); await page.getByLabel("模型", { exact: true }).selectOption(model);
    await page.getByLabel("推理强度（effort）").selectOption("low");
    await page.getByText("高级设置", { exact: true }).click(); await page.getByLabel("工作区（可选）", { exact: true }).fill(workspace);
    await page.getByRole("button", { name: "创建 Bot", exact: true }).click();
    await expect(page.getByText("Bot 已上线，可以开始对话。", { exact: true })).toBeVisible({ timeout: 30_000 });
    await page.getByRole("button", { name: "开始对话", exact: true }).click(); await pair(phone, hub);
    const bot = (await hub.store.bots("owner"))[0]!, conversation = (await hub.store.conversations("owner"))[0]!;
    await selectConversation(phone, conversation.title);
    const stateDir = path.join(root, "bots", bot.id), theme = `紫色风车-${randomBytes(3).toString("hex")}`;
    const snapshot = () => hub.store.snapshot("owner", conversation.id);
    const timeline = () => jsonl<{ timestamp: string; type: string; outcome?: string; metadata?: { messageId?: string; larkMessageId?: string } }>(path.join(stateDir, "timeline.log.jsonl"));
    const native = () => jsonl<Observation>(nativeLog);
    const session = async () => {
      const value = JSON.parse(await readFile(path.join(stateDir, "session.json"), "utf8"));
      return value.chats.find((item: { conversationKey: string }) => item.conversationKey === `lark:${conversation.id}`)?.codexSessionId as string | undefined;
    };
    const send = async (text: string, device = page, prefilled = false) => {
      if (!prefilled) await device.getByRole("textbox", { name: "消息", exact: true }).fill(text);
      if (engine === "claude" && followupMode === "queued" && (await snapshot()).messages.some(message => message.authorType === "bot" && message.status === "streaming")) {
        await device.getByRole("button", { name: "更多聊天操作", exact: true }).click();
        await device.getByRole("button", { name: "作为下一轮发送", exact: true }).click();
      } else await device.getByRole("button", { name: "发送消息", exact: true }).click();
      const accepted = async () => (await snapshot()).messages.find((message) => message.authorType === "user" && blocksText(message.blocks) === text);
      await expect.poll(accepted).toBeTruthy(); return (await accepted())!;
    };
    await send(`请写一篇约 3000 汉字的温暖科幻短篇，讲一位修理风车的工程师和一座海边城市。完整标题是「${theme}」，标题中的编号是作品编号，请原样保留。直接输出标题和故事正文，不要先解释写作计划。不要调用工具、读取或写入文件、发送外部消息。`);
    await expect.poll(async () => (await snapshot()).messages.some((m) => m.authorType === "bot" && m.status === "streaming" && stopText(m.blocks).includes(theme)), { timeout: 90_000, intervals: [30] }).toBe(true);
    const run = (await snapshot()).messages.find((m) => m.authorType === "bot" && m.status === "streaming" && stopText(m.blocks).includes(theme))!;
    await expect.poll(session).toBeTruthy(); const originalSession = await session();
    const followupQuestion = (prefix: string) => `不要调用工具，也不要读取文件。刚才指定的完整故事标题是什么？用一行纯文本回复，先写「${prefix}」，后面紧接完整故事标题，保留作品编号，不要加其他说明。`;
    const followupText = followupQuestion("续聊：");
    const followupInputs: Array<{ id: string; createdAt: number; expectedPrefix: string }> = [];
    if (followupMode === "queued") {
      followupInputs.push({ ...await send(followupQuestion("第一条：")), expectedPrefix: "第一条：" });
      followupInputs.push({ ...await send(followupQuestion("第二条："), phone), expectedPrefix: "第二条：" });
      // Pending inputs stay Hub-owned until their execution slot so users can
      // still edit, cancel and reorder them. Requiring input.received here would
      // assert the retired eager-claim behavior and freeze those controls.
      const queue = new HubPromptQueue(hub.store);
      await expect.poll(async () => (await queue.read("owner", bot.id, conversation.id)).items
        .filter(item => followupInputs.some(input => input.id === item.message.id))
        .map(item => ({ id: item.message.id, state: item.state, editable: item.canEdit, cancellable: item.canCancel, movable: item.canMove })))
        .toEqual(followupInputs.map(input => ({ id: input.id, state: "queued", editable: true, cancellable: true, movable: true })));
      expect((await timeline()).filter(event => event.type === "input.received" && followupInputs.some(input => input.id === (event.metadata?.messageId ?? event.metadata?.larkMessageId)))).toHaveLength(0);
      expect((await hub.store.messageForBot(bot.id, run.id)).status).toBe("streaming");
      expect((await native()).filter((event) => event.type === "native.prompt.sent")).toHaveLength(1);
    } else if (followupMode === "immediate") {
      await page.getByRole("textbox", { name: "消息", exact: true }).fill(followupText);
    }
    for (const device of [page, phone]) await device.evaluate((messageId) => {
      const probe = { clickedAt: 0, stoppedAt: 0 };
      (window as typeof window & { stopProbe: typeof probe }).stopProbe = probe;
      document.addEventListener("click", (event) => { if ((event.target as Element).closest('button[aria-label="停止当前轮次"]')) probe.clickedAt = Date.now(); }, { capture: true });
      const observer = new MutationObserver(() => {
        const row = document.querySelector(`[data-message-id="${messageId}"]`);
        if (row?.textContent?.includes("已停止") && !probe.stoppedAt) { probe.stoppedAt = Date.now(); observer.disconnect(); }
      });
      observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    }, run.id);
    const stop = phone.getByRole("button", { name: "停止当前轮次", exact: true }); await expect(stop).toBeVisible();
    await stop.click();
    const clickedAt = await phone.evaluate(() => (window as typeof window & { stopProbe: { clickedAt: number } }).stopProbe.clickedAt); expect(clickedAt).toBeGreaterThan(0);
    if (followupMode === "immediate") followupInputs.push({ ...await send(followupText, page, true), expectedPrefix: "续聊：" });
    const completed = async () => (await timeline()).find((event) => event.type === "turn.completed" && event.outcome === "interrupted" && (event.metadata?.messageId ?? event.metadata?.larkMessageId) === run.replyTo);
    await expect.poll(completed, { timeout: 15_000, intervals: [20] }).toBeTruthy();
    const settledAt = Date.parse((await completed())!.timestamp);
    const visibleMs: Record<string, number> = {};
    for (const [device, label] of [[page, "desktop"], [phone, "phone"]] as const) {
      await expect(device.locator(`[data-message-id="${run.id}"]`)).toContainText("已停止");
      visibleMs[label] = await device.evaluate(() => (window as typeof window & { stopProbe: { stoppedAt: number } }).stopProbe.stoppedAt) - clickedAt;
    }
    const terminal = async () => {
      const observed = await native();
      const enginePids = new Set(observed.filter((entry) => entry.type === "native.spawn" && entry.executable === path.basename(executable)).map((entry) => entry.pid));
      return observed.find((entry) => entry.at >= clickedAt && (
        engine === "codex" ? entry.type === "native.turn.end" && entry.status === "interrupted" :
        engine === "claude" ? entry.type === "native.turn.end" && !!entry.stopReason?.startsWith("aborted_") :
        engine === "kimi" ? entry.type === "native.prompt.end" && entry.stopReason === "cancelled" :
        engine === "deepseek" ? entry.type === "cancel.ack" && entry.method === "session.cancel" && entry.ok :
        entry.type === "native.exit" && enginePids.has(entry.pid)));
    };
    await expect.poll(terminal, { timeout: 15_000, intervals: [20] }).toBeTruthy();
    const nativeStop = (await terminal())!;
    if (engine === "claude") {
      const events = await native();
      expect(events.some(event => event.type === "cancel.ack" && event.method === "claude.interrupt" && event.ok && event.at >= clickedAt)).toBe(true);
      expect(events.some(event => event.type === "native.exit" && event.pid === nativeStop.pid)).toBe(false);
    }
    const stoppedVersion = (await hub.store.messageForBot(bot.id, run.id)).version;
    if (followupMode === "after-native") {
      await expect.poll(async () => (await hub.store.pendingForBot(bot.id)).length).toBe(0);
      followupInputs.push({ ...await send(followupText), expectedPrefix: "续聊：" });
    }
    for (const input of followupInputs) {
      const done = async () => (await timeline()).find((event) => event.type === "turn.completed" && (event.metadata?.messageId ?? event.metadata?.larkMessageId) === input.id);
      await expect.poll(done, { timeout: 90_000 }).toBeTruthy();
      expect((await done())!.outcome).toBe("success");
      const replies = (await snapshot()).messages.filter((message) => message.replyTo === input.id && message.authorType === "bot" && message.status === "complete");
      expect(replies).toHaveLength(1);
      const answer = answerText(replies[0]!.blocks);
      expect(answer).toContain(theme); expect(answer).toContain(input.expectedPrefix);
      for (const other of followupInputs.filter((other) => other.id !== input.id)) expect(answer).not.toContain(other.expectedPrefix);
    }
    expect(await session()).toBe(originalSession);
    expect((await hub.store.messageForBot(bot.id, run.id)).version).toBe(stoppedVersion);
    await expect.poll(async () => (await hub.store.pendingForBot(bot.id)).length).toBe(0);
    const promptEvents = (await native()).filter((event) => event.type === "native.prompt.sent");
    expect(promptEvents).toHaveLength(1 + followupInputs.length);
    if (engine === "claude") {
      expect(new Set(promptEvents.map(event => event.pid)).size).toBe(1);
      expect((await native()).some(event => event.type === "native.exit" && event.pid === nativeStop.pid)).toBe(false);
    }
    const followupStarts = (await timeline()).filter((event) => event.type === "turn.started" && followupInputs.some((input) => input.id === (event.metadata?.messageId ?? event.metadata?.larkMessageId)));
    expect(followupStarts.map((event) => (event.metadata?.messageId ?? event.metadata?.larkMessageId))).toEqual(followupInputs.map((input) => input.id));
    expect(promptEvents.slice(1).every((event) => event.at >= clickedAt)).toBe(true);
    if (followupMode === "queued") expect(followupInputs.every((input) => input.createdAt < clickedAt)).toBe(true);
    if (followupMode === "immediate") expect(followupInputs[0]!.createdAt - clickedAt).toBeLessThan(500);
    for (const device of [page, phone]) {
      await device.reload(); await waitForClientOnline(device);
      await selectConversation(device, conversation.title);
      for (const input of followupInputs) {
        const reply = (await snapshot()).messages.find((message) => message.replyTo === input.id && message.authorType === "bot" && message.status === "complete")!;
        await expect(device.locator(`[data-message-id="${reply.id}"]`)).toContainText(theme);
        await expect(device.locator(`[data-message-id="${reply.id}"]`)).toContainText(input.expectedPrefix);
      }
    }
    expect((await native()).filter((event) => event.type === "native.prompt.sent")).toHaveLength(promptEvents.length);
    for (const [device, label] of [[page, "desktop"], [phone, "phone"]] as const) await device.screenshot({ path: info.outputPath(`stop-${engine}-${label}.png`) });
    receipt = { engine, model: model || "CLI default", version, effort: "low", pairedBrowserContexts: 2, physicalDevices: false,
      clickToLocalTurnSettledMs: settledAt - clickedAt, clickToVisibleMs: visibleMs, clickToNativeBoundaryMs: nativeStop.at - clickedAt,
      nativeBoundary: nativeStop.type, nativeBoundaryDetails: { pid: nativeStop.pid, method: nativeStop.method, status: nativeStop.status, stopReason: nativeStop.stopReason, signal: nativeStop.signal },
      nativeEvents: (await native()).filter((event) => event.type !== "native.session"),
      realTextBeforeStop: answerText(run.blocks).includes(theme), allowReasoningMarker, followupMode,
      nativePromptCount: promptEvents.length, followupCount: followupInputs.length, followupInputOffsetsMs: followupInputs.map((input) => input.createdAt - clickedAt),
      hubQueueEditableBeforeStop: followupMode === "queued",
      distinctFollowupReplies: followupInputs.map((input) => input.expectedPrefix),
      followupNativePromptOffsetsMs: promptEvents.slice(1).map((event) => event.at - clickedAt), fifo: true, bothDevicesReloadedWithoutReplay: true,
      sameNativeSession: true, themeRemembered: true, stoppedMessageUnchangedAfterNextTurn: true,
      nativeObserver: "read-only in-worker spawn/protocol observer; no prompt or native result injection", providerComputeCessationMeasured: false };
    await writeFile(info.outputPath(`stop-${engine}.json`), JSON.stringify(receipt, null, 2));
    expect(settledAt - clickedAt).toBeLessThan(1000); for (const ms of Object.values(visibleMs)) { expect(ms).toBeGreaterThanOrEqual(0); expect(ms).toBeLessThan(1000); }
    expect(nativeStop.at - clickedAt).toBeLessThan(1000);
  } catch (error) {
    const conversations = await hub.store.conversations("owner");
    await writeFile(info.outputPath(`stop-${engine}-diagnostics.json`), JSON.stringify({ receipt, native: await jsonl(nativeLog),
      // Synthetic test messages only; never dump auth/config state.
      conversations: await Promise.all(conversations.map(async (conversation) => ({ id: conversation.id, messages: (await hub.store.snapshot("owner", conversation.id)).messages.map((message) => ({ id: message.id, replyTo: message.replyTo, authorType: message.authorType, status: message.status, answer: answerText(message.blocks) })) }))),
      bots: await Promise.all((await hub.store.bots("owner")).map(async (bot) => ({ engine: bot.engine, status: hub.botManager!.serviceStatus(bot.id), timeline: await jsonl(path.join(root, "bots", bot.id, "timeline.log.jsonl")) }))) }, null, 2));
    throw error;
  } finally {
    await phoneContext.close(); await page.close(); await hub.close();
    const observed = await jsonl<Observation>(nativeLog);
    if (engine === "codex") await archiveAcceptanceThreads(root);
    if (cleanupClaude) await cleanupClaude([...new Set(observed.filter((event) => event.type === "native.session").map((event) => event.sessionId!).filter(Boolean))]);
    if (receipt) await writeFile(info.outputPath(`stop-${engine}.json`), JSON.stringify({ ...receipt, ownedHubStopped: true, codexThreadsArchived: engine === "codex", claudeFixtureTranscriptsRemoved: !!cleanupClaude, kimiPrivateHome: engine === "kimi" }, null, 2));
    await rm(root, { recursive: true, force: true });
  }
});
