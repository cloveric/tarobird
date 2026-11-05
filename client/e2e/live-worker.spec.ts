import { preparePairing } from "./fixtures/pairing-invite.js";
import { clickAppAction } from "./fixtures/desktop-actions.js";
import { selectConversation, waitForClientOnline } from "./fixtures/mobile.js";
import { archiveAcceptanceThreads } from "../../tests/helpers/codex-acceptance.js";
import { test, expect } from "@playwright/test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HubServer } from "../../src/hub/server.js";
import { blocksText } from "../../src/client-protocol/index.js";

// Opt in only: this acceptance uses an already-authenticated real engine CLI.
// The ordinary test suite never creates a paid model turn or changes login.
const engine = process.env.TAROCUB_LIVE_ENGINE ?? "codex";
if (!["codex", "claude", "kimi", "deepseek", "antigravity"].includes(engine)) throw new Error("Unknown TAROCUB_LIVE_ENGINE");
const model = engine === "codex" ? "gpt-6-astra" : engine === "claude" ? "sonnet" : "";
test.use({ actionTimeout: 15_000 });
test(`a client-created ${engine} production worker resumes its session and settles a killed turn`, async ({ page, browser }, info) => {
  test.skip(process.env.TAROCUB_LIVE_WORKER !== "1", "requires explicit real-engine acceptance");
  test.setTimeout(300_000);
  const root = await mkdtemp(path.join(os.tmpdir(), "live-client-worker-"));
  const workspace = path.join(root, "workspace"); await mkdir(workspace);
  const artifact = path.join(workspace, "engine-acceptance.txt");
  const expectedArtifact = `TaroCub ${engine} acceptance\n紫色橡果\n`;
  await writeFile(artifact, expectedArtifact);
  const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve("dist"), managedBots: { entrypoint: path.resolve("../dist/src/index.js") } });
  const phoneContext = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const phone = await phoneContext.newPage();
  try {
    await page.goto(hub.url); await preparePairing(page, hub); await page.getByRole("button", { name: "配对此设备", exact: true }).click();
    await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
    await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" });
    await clickAppAction(page, "新建 Bot", page.getByRole("button", { name: "新建 Bot", exact: true }));
    await page.getByLabel("Bot 名称", { exact: true }).fill("真实引擎验收助手");
    await page.getByLabel("引擎", { exact: true }).selectOption(engine);
    await page.getByLabel("模型", { exact: true }).selectOption(model);
    await page.getByLabel("推理强度（effort）").selectOption("low");
    await page.getByText("高级设置", { exact: true }).click();
    await page.getByLabel("工作区（可选）", { exact: true }).fill(workspace);
    await page.getByRole("button", { name: "创建 Bot", exact: true }).click();
    await expect(page.getByText("Bot 已上线，可以开始对话。", { exact: true })).toBeVisible({ timeout: 15_000 });
    await page.getByRole("button", { name: "开始对话", exact: true }).click();
    const bot = (await hub.store.bots("owner"))[0]!, conversation = (await hub.store.conversations("owner"))[0]!;
    await phone.goto(hub.url); await preparePairing(phone, hub); await phone.getByRole("button", { name: "配对此设备", exact: true }).click();
    await hub.auth.approve(await phone.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
    await phone.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" }); await waitForClientOnline(phone);
    await selectConversation(phone, conversation.title);
    const pid = () => Number(hub.botManager!.serviceStatus(bot.id).text.match(/PID: (\d+)/)?.[1] ?? 0);
    const sessionId = async () => {
      try { const state = JSON.parse(await readFile(path.join(root, "bots", bot.id, "session.json"), "utf8")) as { chats: { conversationKey: string; codexSessionId: string }[] }; return state.chats.find((s) => s.conversationKey === `lark:${conversation.id}`)?.codexSessionId ?? ""; }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return ""; throw error; }
    };
    const send = async (text: string) => { await page.getByRole("textbox", { name: "消息", exact: true }).fill(text); await page.getByRole("button", { name: "发送消息", exact: true }).click(); };
    const complete = async (marker: string) => {
      await expect.poll(async () => (await hub.store.snapshot("owner", conversation.id)).messages.some((m) => m.authorType === "bot" && m.status === "complete" && blocksText(m.blocks).includes(marker)), { timeout: 60_000 }).toBe(true);
      for (const device of [page, phone]) await expect(device.locator(".message-blocks").getByText(marker, { exact: true })).toBeVisible();
      await expect.poll(async () => (await hub.store.pendingForBot(bot.id)).length).toBe(0);
    };
    await send("这是客户端验收，不调用任何工具，不读取文件，不发送外部消息。本次绘画主题是紫色橡果。只回复一行 TAROCUB_WORKER_READY。");
    await complete("TAROCUB_WORKER_READY");
    await expect.poll(sessionId, { timeout: 15_000 }).not.toBe("");
    const originalSession = await sessionId();
    const firstPid = pid(); expect(firstPid).toBeGreaterThan(1); await hub.botManager!.restart(bot.id);
    await expect.poll(() => pid(), { timeout: 15_000 }).not.toBe(firstPid);
    await expect.poll(async () => (await hub.store.bots("owner"))[0]?.online, { timeout: 15_000 }).toBe(1);
    await send("不要调用工具。刚才我指定的绘画主题是什么？只回复主题本身。"); await complete("紫色橡果");
    expect(await sessionId()).toBe(originalSession);
    const nativeQuestion = ["claude", "kimi", "deepseek"].includes(engine);
    if (nativeQuestion) {
      await send('这是临时验收。调用当前引擎的原生提问工具，只问一个问题“验收选择哪种颜色？”，选项“蓝色”和“绿色”，单选。不要用普通文字替代表单。等待用户选完后，只回复一行 QUESTION_OK 加一个空格和选中的颜色。本轮不要使用其他工具。');
      for (const device of [page, phone]) await expect(device.getByRole("radio", { name: "蓝色", exact: true })).toBeVisible({ timeout: 90_000 });
      await phone.getByRole("radio", { name: "蓝色", exact: true }).check();
      await phone.screenshot({ path: info.outputPath("native-question-phone.png") });
      await phone.getByRole("button", { name: "提交", exact: true }).click();
      await complete("QUESTION_OK 蓝色");
      for (const device of [page, phone]) await expect(device.getByRole("button", { name: "提交", exact: true }).filter({ visible: true })).toHaveCount(0);
    }
    await send(`文件交付验收。工作区中已有我准备好的 UTF-8 文本文件 ${artifact}。使用当前平台支持的方式，把它作为可下载的文件附件发送到当前对话，附件说明为 ENGINE_FILE_OK。保留文件原样，勿发送到外部平台。`);
    await expect.poll(async () => (await hub.store.snapshot("owner", conversation.id)).messages.some((m) => m.authorType === "bot" && m.blocks.some((b) => b.type === "file" && b.name === "engine-acceptance.txt")), { timeout: 90_000 }).toBe(true);
    await expect.poll(async () => (await hub.store.pendingForBot(bot.id)).length).toBe(0);
    for (const device of [page, phone]) {
      const file = device.getByRole("region", { name: "engine-acceptance.txt", exact: true });
      await expect(file).toBeVisible();
      const download = device.waitForEvent("download");
      await file.getByRole("button", { name: "另存为 engine-acceptance.txt", exact: true }).click();
      expect(await readFile((await (await download).path())!, "utf8")).toBe(expectedArtifact);
    }
    const delivered = (await hub.store.snapshot("owner", conversation.id)).messages.filter((m) => m.authorType === "bot" && m.blocks.some((b) => b.type === "file" && b.name === "engine-acceptance.txt"));
    expect(delivered).toHaveLength(1);
    expect(blocksText(delivered[0]!.blocks)).toContain("ENGINE_FILE_OK");
    const before = (await hub.store.snapshot("owner", conversation.id)).messages.map((m) => m.id);
    await send("这是临时故障恢复验收。不要调用工具、读取文件或发送外部消息。第一行输出 TAROCUB_STREAM_STARTED，然后逐行从1数到2000，每行解释这个数字。");
    // A starting run card alone does not prove the real engine has streamed.
    await expect.poll(async () => (await hub.store.snapshot("owner", conversation.id)).messages.some((m) => !before.includes(m.id) && m.authorType === "bot" && m.status === "streaming" && blocksText(m.blocks).includes("TAROCUB_STREAM_STARTED")), { timeout: 60_000 }).toBe(true);
    const unfinished = (await hub.store.snapshot("owner", conversation.id)).messages.find((m) => !before.includes(m.id) && m.authorType === "bot" && m.status === "streaming" && blocksText(m.blocks).includes("TAROCUB_STREAM_STARTED"))!;
    const killedPid = pid(); expect(killedPid).toBeGreaterThan(1); process.kill(killedPid, "SIGKILL");
    await expect.poll(() => pid(), { timeout: 15_000 }).not.toBe(killedPid);
    await expect.poll(async () => (await hub.store.messageForBot(bot.id, unfinished.id)).status, { timeout: 20_000 }).toBe("error");
    await expect.poll(async () => (await hub.store.pendingForBot(bot.id)).length).toBe(0);
    for (const device of [page, phone]) await expect(device.locator(`[data-message-id="${unfinished.id}"]`)).toContainText("处理因实例重启而中断");
    const timeline = (await readFile(path.join(root, "bots", bot.id, "timeline.log.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    expect(timeline.filter((event) => event.type === "turn.completed" && event.outcome === "interrupted" && (event.metadata?.messageId ?? event.metadata?.larkMessageId) === unfinished.replyTo)).toHaveLength(1);
    await page.screenshot({ path: info.outputPath("worker-crash-recovery.png") });
    await phone.screenshot({ path: info.outputPath("worker-crash-recovery-phone.png") });
    await send("恢复验收。不要调用工具。只回复一行 TAROCUB_AFTER_CRASH_OK。"); await complete("TAROCUB_AFTER_CRASH_OK");
    expect(await sessionId()).toBe(originalSession);
    expect((await hub.store.snapshot("owner", conversation.id)).messages.filter((m) => m.id.startsWith("recovery_")).length).toBe(1);
    await send("手机停止验收。不要调用工具。第一行输出 PHONE_STOP_STARTED，然后逐行从1数到2000，每行解释这个数字。");
    const stoppingMessage = async () => (await hub.store.snapshot("owner", conversation.id)).messages.find((m) => m.authorType === "bot" && m.status === "streaming" && blocksText(m.blocks).includes("PHONE_STOP_STARTED"));
    await expect.poll(async () => !!await stoppingMessage(), { timeout: 60_000 }).toBe(true);
    const stopped = (await stoppingMessage())!;
    await clickAppAction(phone, "停止当前轮次", phone.getByRole("button", { name: "停止当前轮次", exact: true }));
    await expect.poll(async () => (await hub.store.pendingForBot(bot.id)).length).toBe(0);
    for (const device of [page, phone]) await expect(device.locator(`[data-message-id="${stopped.id}"]`)).toContainText("已停止", { timeout: 15_000 });
    await send("停止后的恢复验收。不要调用工具。只回复一行 PHONE_STOP_RECOVERED。"); await complete("PHONE_STOP_RECOVERED");
    expect(await sessionId()).toBe(originalSession);
    const evidence = { testedAt: new Date().toISOString(), realEngine: engine, model, createdThroughUI: true, restartRememberedContext: true, killedTurnSettled: true, sameNativeSessionAfterCrash: true, nativeStreamBeforeKill: true, pairedDevices: 2, nativeQuestionAnsweredOnPhone: nativeQuestion, phoneStopAndResume: true, downloadsVerified: 2, captionWithAttachment: true, deliveryWithoutPromptingMarkerSyntax: true, duplicateAttachments: 0, duplicateRecoveryMessages: 0 };
    await writeFile(info.outputPath("worker-lifecycle.json"), JSON.stringify(evidence, null, 2));
    await info.attach("worker-lifecycle", { body: JSON.stringify(evidence), contentType: "application/json" });
  } catch (error) {
    // Capture only this temporary Bot's synthetic history and redacted service log.
    // Diagnostics survive cleanup without retaining engine credentials or identities.
    for (const bot of await hub.store.bots("owner")) {
      await writeFile(info.outputPath(`worker-${bot.engine}-diagnostics.json`), JSON.stringify({ status: hub.botManager!.serviceStatus(bot.id), sessions: await readFile(path.join(root, "bots", bot.id, "session.json"), "utf8").catch(() => "absent"), timeline: await readFile(path.join(root, "bots", bot.id, "timeline.log.jsonl"), "utf8").catch(() => "absent") }, null, 2));
    }
    throw error;
  } finally { await phoneContext.close(); await page.close(); await hub.close(); if (engine === "codex") await archiveAcceptanceThreads(root); await rm(root, { recursive: true, force: true }); }
});
