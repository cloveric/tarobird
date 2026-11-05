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

test("real Claude queues, withdraws and immediately consumes App input without stopping background agents", async ({ page, browser }, info) => {
  test.skip(process.env.TAROBOT_LIVE_CLAUDE_PARITY !== "1", "explicit real Claude acceptance only");
  test.setTimeout(360_000);
  const executable = process.env.CLAUDE_EXECUTABLE || "claude";
  const version = execFileSync(executable, ["--version"], { encoding: "utf8" }).trim();
  const root = await mkdtemp(path.join(os.tmpdir(), "live-claude-app-tools-")), workspace = path.join(root, "workspace"); await mkdir(workspace);
  const cleanup = await ownClaudeFixtureTranscripts(workspace), nativeLog = path.join(root, "native.jsonl"), entrypoint = path.resolve("../dist/src/index.js");
  const env = { ...process.env, TAROBOT_NATIVE_INPUT_OBSERVER: "1", TAROCUB_STOP_WORKER_ENTRY: entrypoint, TAROCUB_STOP_OBSERVER_LOG: nativeLog,
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
    await composer.fill('这是隔离的本地消息交互验收。只允许对127.0.0.1执行ping，不访问其他网络或修改文件。先用Agent工具启动一个后台子代理（run_in_background:true），description严格为 INPUT_BACKGROUND。子代理只用Bash在前台运行 ping -c 120 127.0.0.1，timeout:180000，然后回复 BACKGROUND_DONE。主代理随后用Bash在前台执行 ping -c 60 127.0.0.1，timeout:120000，不设置run_in_background。用户会在运行期间发消息。收到新消息后按其要求回答，保留所有后台任务，不调用TaskOutput，不自行停止任何工具或子代理。');
    await send.click();
    await expect.poll(async () => (await native()).some(event => event.type === "input.tool" && event.foregroundPing), { timeout: 90_000 }).toBe(true);
    await composer.fill("记录 INPUT_A_ORDER。普通发送不需要打断工具，等 CLI 适时读入。"); await send.click(); await expect(composer).toHaveValue("");
    const byText = async (text: string) => (await snapshot()).messages.find(message => message.authorType === "user" && blocksText(message.blocks) === text);
    const aText = "记录 INPUT_A_ORDER。普通发送不需要打断工具，等 CLI 适时读入。";
    const receipt = (message: any) => message?.blocks.find((block: any) => block.type === "steering");
    await expect.poll(async () => receipt(await byText(aText))?.nativeInput?.state).toBe("queued");
    expect((await native()).filter(event => event.type === "input.control")).toHaveLength(0);
    await page.screenshot({ path: info.outputPath("native-input-live-desktop-pending.png") });
    const phoneComposer = phone.getByRole("textbox", { name: "消息", exact: true });
    await phoneComposer.fill("INPUT_CANCELLED 不应进入模型。"); await phone.getByRole("button", { name: "发送消息", exact: true }).click(); await expect(phoneComposer).toHaveValue("");
    const c = await byText("INPUT_CANCELLED 不应进入模型。"); expect(c).toBeTruthy();
    const cBubble = phone.locator(`[data-message-id="${c!.id}"]`);
    await cBubble.getByRole("button", { name: "撤回编辑", exact: true }).click(); await expect(phoneComposer).toHaveValue("INPUT_CANCELLED 不应进入模型。");
    await expect.poll(async () => receipt(await byText("INPUT_CANCELLED 不应进入模型。"))?.nativeInput?.state).toBe("cancelled");
    await phoneComposer.fill("立即读入 INPUT_D_ORDER，最终只回复 INPUT_NATIVE_OK，并保持现有后台任务运行。");
    await phone.getByRole("button", { name: "更多聊天操作", exact: true }).click();
    await phone.screenshot({ path: info.outputPath("native-input-live-phone-actions.png") });
    await phone.getByLabel("立即发送", { exact: true }).click(); await expect(phoneComposer).toHaveValue("");
    const dText = "立即读入 INPUT_D_ORDER，最终只回复 INPUT_NATIVE_OK，并保持现有后台任务运行。";
    await expect.poll(async () => receipt(await byText(dText))?.nativeInput?.state, { timeout: 60_000 }).toBe("received");
    await expect.poll(async () => receipt(await byText(aText))?.nativeInput?.state, { timeout: 15_000 }).toBe("received");
    await expect.poll(async () => (await snapshot()).messages.some(message => message.authorType === "bot" && message.status === "complete" && blocksText(message.blocks).includes("INPUT_NATIVE_OK")), { timeout: 60_000 }).toBe(true);
    const events = await native(), sent = events.filter(event => event.type === "input.sent");
    expect(sent).toHaveLength(4); expect(new Set(sent.map(event => event.pid)).size).toBe(1);
    for (const input of sent.slice(1)) { expect(input.origin).toBe("human"); expect(input.priority).toBeUndefined(); }
    const controls = events.filter(event => event.type === "input.control");
    expect(controls.filter(event => event.request.subtype === "interrupt")).toHaveLength(1);
    expect(controls.find(event => event.request.subtype === "interrupt")?.request).toMatchObject({ send_now: true, message_uuid: sent[3].uuid });
    expect(controls.every(event => !event.request.cancel_queued)).toBe(true);
    expect(events.some(event => event.type === "input.control.receipt" && event.response.cancelled === true)).toBe(true);
    expect(events.some(event => event.type === "input.control.receipt" && ["delivering", "stopped"].includes(event.response.send_now))).toBe(true);
    const results = events.filter(event => event.type === "input.result" && !event.error);
    const aResult = results.findIndex(event => event.uuids?.includes(sent[1].uuid)), dResult = results.findIndex(event => event.uuids?.includes(sent[3].uuid));
    expect(aResult).toBeGreaterThanOrEqual(0); expect(dResult).toBeGreaterThanOrEqual(aResult);
    expect(results.every(event => !event.uuids?.includes(sent[2].uuid))).toBe(true);
    if (aResult === dResult) expect(results[aResult].uuids.indexOf(sent[1].uuid)).toBeLessThan(results[aResult].uuids.indexOf(sent[3].uuid));
    expect(events.some(event => event.type === "native.exit" && event.pid === sent[0].pid)).toBe(false);
    await phone.getByRole("button", { name: "子代理与后台任务", exact: true }).click();
    const dialog = phone.getByRole("dialog", { name: "子代理与后台任务", exact: true });
    await expect(dialog.getByRole("article", { name: "INPUT_BACKGROUND", exact: true })).toContainText("执行中");
    await page.screenshot({ path: info.outputPath("native-input-live-desktop.png") });
    await phone.screenshot({ path: info.outputPath("native-input-live-phone-tasks.png") });
    await dialog.getByRole("button", { name: "关闭任务列表", exact: true }).click();
    await phone.screenshot({ path: info.outputPath("native-input-live-phone.png") });
    await writeFile(info.outputPath("native-input-live.json"), JSON.stringify({ version, model: "sonnet", effort: "low", physicalDevices: false, realCLI: true, ordinaryDidNotInterrupt: true, withdrawnBeforeModel: true, sendNowUsedNativeControl: true, backgroundAgentPreserved: true, orderedModelReceipts: true, events }, null, 2));
  } catch (error) {
    await writeFile(info.outputPath("claude-parity-diagnostics.json"), JSON.stringify({ native: await native(), messages: conversationId ? (await snapshot()).messages : [], timeline: botId ? await readFile(path.join(root, "bots", botId, "timeline.log.jsonl"), "utf8").catch(() => "") : "" }, null, 2));
    throw error;
  } finally {
    await phoneContext.close(); await page.close(); await hub.close();
    await cleanup([...new Set((await native()).filter(event => event.type === "native.session").map(event => event.sessionId))]);
    await rm(root, { recursive: true, force: true });
  }
});
