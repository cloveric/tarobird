import { preparePairing } from "./fixtures/pairing-invite.js";
import { test, expect, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { HubServer } from "../../src/hub/server.js";
import { blocksText } from "../../src/client-protocol/index.js";
import { clickAppAction } from "./fixtures/desktop-actions.js";
import { selectConversation, waitForClientOnline } from "./fixtures/mobile.js";
import { ownClaudeFixtureTranscripts } from "./fixtures/claude-app-observer.js";

test("real Claude adopts App input at a tool boundary and independently stops a subagent", async ({ page, browser }, info) => {
  test.skip(process.env.TAROBOT_LIVE_CLAUDE_PARITY !== "1", "explicit real Claude acceptance only");
  test.setTimeout(240_000);
  const executable = process.env.CLAUDE_EXECUTABLE || "claude";
  const version = execFileSync(executable, ["--version"], { encoding: "utf8" }).trim();
  const root = await mkdtemp(path.join(os.tmpdir(), "live-claude-app-tools-")), workspace = path.join(root, "workspace"); await mkdir(workspace);
  const cleanup = await ownClaudeFixtureTranscripts(workspace), nativeLog = path.join(root, "native.jsonl"), entrypoint = path.resolve("../dist/src/index.js");
  const env = { ...process.env, TAROCUB_STOP_WORKER_ENTRY: entrypoint, TAROCUB_STOP_OBSERVER_LOG: nativeLog,
    TAROCUB_STOP_PROTOCOL_MODULE: pathToFileURL(path.resolve("../dist/src/codex/deepseek-harness-protocol.js")).href,
    NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import=${pathToFileURL(path.resolve("e2e/fixtures/stop-observer.mjs")).href}` };
  const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve("dist"), managedBots: { entrypoint, env } });
  const phoneContext = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }), phone = await phoneContext.newPage();
  const native = async (): Promise<any[]> => (await readFile(nativeLog, "utf8").catch(() => "")).split("\n").filter(Boolean).map(line => JSON.parse(line));
  let conversationId = "", botId = "";
  const pair = async (device: Page) => {
    await device.goto(hub.url); await preparePairing(device, hub); await device.getByRole("button", { name: "配对此设备", exact: true }).click();
    await hub.auth.approve(await device.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
    await device.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" }); await waitForClientOnline(device);
  };
  const snapshot = () => hub.store.snapshot("owner", conversationId);
  try {
    await pair(page); await clickAppAction(page, "新建 Bot");
    await page.getByLabel("Bot 名称", { exact: true }).fill("Claude 原生交互验收");
    await page.getByLabel("引擎", { exact: true }).selectOption("claude"); await page.getByLabel("模型", { exact: true }).selectOption("sonnet");
    await page.getByLabel("推理强度（effort）").selectOption("low");
    await page.getByText("高级设置", { exact: true }).click(); await page.getByLabel("工作区（可选）", { exact: true }).fill(workspace);
    await page.getByRole("button", { name: "创建 Bot", exact: true }).click();
    await expect(page.getByText("Bot 已上线，可以开始对话。", { exact: true })).toBeVisible({ timeout: 30_000 });
    await page.getByRole("button", { name: "开始对话", exact: true }).click();
    const conversation = (await hub.store.conversations("owner"))[0]!; conversationId = conversation.id; botId = (await hub.store.bots("owner"))[0]!.id;
    await pair(phone); await selectConversation(phone, conversation.title);
    const composer = page.getByRole("textbox", { name: "消息", exact: true }), send = page.getByRole("button", { name: "发送消息", exact: true });
    await composer.fill('这是本地交互验收，只允许对127.0.0.1执行ping，不访问其他网络、文件或外部服务。请用Agent工具启动两个独立后台子代理（run_in_background:true），description分别严格为 PARITY_ALPHA 和 PARITY_BETA。每个子代理仅用Bash在前台运行 ping -c 100 127.0.0.1，timeout:120000，完成后回复自身名称；不做其他工作。启动两个后，主代理输出 PARITY_READY，然后自己用Bash前台运行 ping -c 30 127.0.0.1，timeout:60000，不将它放后台。这期间用户会补充要求；工具结束后按最新补充答复，不等待两个子代理，不调用TaskOutput。');
    await send.click();
    await expect(page.getByRole("button", { name: "子代理与后台任务", exact: true })).toBeVisible({ timeout: 60_000 });
    await phone.getByRole("button", { name: "子代理与后台任务", exact: true }).click();
    const dialog = phone.getByRole("dialog", { name: "子代理与后台任务", exact: true });
    const alpha = dialog.getByRole("article", { name: "PARITY_ALPHA", exact: true }), beta = dialog.getByRole("article", { name: "PARITY_BETA", exact: true });
    await expect(alpha).toContainText("执行中", { timeout: 60_000 }); await expect(beta).toContainText("执行中", { timeout: 60_000 });
    await expect.poll(async () => (await snapshot()).messages.some(message => message.authorType === "bot" && blocksText(message.blocks).includes("PARITY_READY")), { timeout: 60_000 }).toBe(true);
    await composer.fill("最终只回复 PARITY_MANGO。保持其余后台任务运行，不停止它们。");
    await expect(send).toHaveAttribute("title", "普通发送，不打断当前任务；Ctrl+Enter 立即发送"); await send.click(); await expect(composer).toHaveValue("");
    await expect.poll(async () => (await snapshot()).messages.some(message => message.blocks.some(block => block.type === "steering" && block.outcome === "accepted")), { timeout: 15_000 }).toBe(true);
    await alpha.getByRole("button", { name: "停止此任务", exact: true }).click();
    await expect(alpha).toContainText("已停止", { timeout: 20_000 }); await expect(beta).toContainText("执行中");
    const final = async () => (await snapshot()).messages.find(message => message.authorType === "bot" && message.status === "complete" && blocksText(message.blocks).includes("PARITY_MANGO"));
    await expect.poll(final, { timeout: 60_000 }).toBeTruthy();
    await expect.poll(async () => (await snapshot()).messages.some(message => message.blocks.some(block => block.type === "steering" && block.mode === "message" && block.nativeInput?.state === "received")), { timeout: 10_000 }).toBe(true);
    await expect(beta).toContainText("执行中"); await page.screenshot({ path: info.outputPath("claude-steered-desktop.png") }); await phone.screenshot({ path: info.outputPath("claude-task-phone.png") });
    await composer.fill("不要调用工具。刚才要求最终回复的英文标记是什么？只回复该标记。"); await send.click();
    await expect.poll(async () => (await snapshot()).messages.filter(message => message.authorType === "bot" && message.status === "complete" && blocksText(message.blocks).includes("PARITY_MANGO")).length, { timeout: 60_000 }).toBe(2);
    await expect(beta).toContainText("执行中"); await beta.getByRole("button", { name: "停止此任务", exact: true }).click(); await expect(beta).toContainText("已停止", { timeout: 20_000 });
    const events = await native(), inputs = events.filter(event => event.type === "native.prompt.sent");
    expect(inputs).toHaveLength(3); expect(new Set(inputs.map(event => event.pid)).size).toBe(1);
    expect(events.filter(event => event.type === "cancel.ack" && event.method === "claude.stop_task" && event.ok)).toHaveLength(2);
    expect(events.some(event => event.type === "native.exit" && event.pid === inputs[0].pid)).toBe(false);
    await writeFile(info.outputPath("claude-parity.json"), JSON.stringify({ version, model: "sonnet", effort: "low", physicalDevices: false, realNativeTasks: true, appSteerAccepted: true, adoptionReceiptPersisted: true, nativeSteerUsed: true, targetStopPreservesOtherAgent: true, sameProcessRecall: true, nativeEvents: events }, null, 2));
  } catch (error) {
    await writeFile(info.outputPath("claude-parity-diagnostics.json"), JSON.stringify({ native: await native(), messages: conversationId ? (await snapshot()).messages : [], timeline: botId ? await readFile(path.join(root, "bots", botId, "timeline.log.jsonl"), "utf8").catch(() => "") : "" }, null, 2));
    throw error;
  } finally {
    await phoneContext.close(); await page.close(); await hub.close();
    await cleanup([...new Set((await native()).filter(event => event.type === "native.session").map(event => event.sessionId))]);
    await rm(root, { recursive: true, force: true });
  }
});
