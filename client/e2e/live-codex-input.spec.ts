import { preparePairing } from "./fixtures/pairing-invite.js";
import { clickAppAction } from "./fixtures/desktop-actions.js";
import { archiveAcceptanceThreads } from "../../tests/helpers/codex-acceptance.js";
import { mobileChatAction, selectConversation, waitForClientOnline } from "./fixtures/mobile.js";
import { test, expect, type Page } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HubServer } from "../../src/hub/server.js";
import { blocksText } from "../../src/client-protocol/index.js";

test("real Codex questions and MCP forms work across devices and cancel on stop", async ({ page, browser }, info) => {
  test.skip(process.env.TAROCUB_LIVE_CODEX_INPUT !== "1", "requires explicit real-engine acceptance");
  const cliVersion = execFileSync(process.env.CODEX_EXECUTABLE || "codex", ["--version"], { encoding: "utf8" }).trim();
  test.setTimeout(240_000);
  const root = await mkdtemp(path.join(os.tmpdir(), "live-codex-input-"));
  const workspace = path.join(root, "workspace"); await mkdir(workspace);
  const nonce = randomBytes(16).toString("hex"); await writeFile(path.join(root, "nonce.txt"), nonce);
  const mcpOverride = `mcp_servers.acceptance={command=${JSON.stringify(process.execPath)},args=${JSON.stringify([path.resolve("e2e/fixtures/live-elicitation-mcp.mjs"), root])},tool_timeout_sec=120}`;
  const wrapper = path.join(root, "codex-acceptance.cjs");
  // 0.159.3 exposes this native tool in Default mode behind a feature flag.
  // Enable it for this CLI process only; do not edit the operator's config.
  await writeFile(wrapper, `#!${process.execPath}
const { spawn } = require('node:child_process');
const { appendFileSync } = require('node:fs');
const args = process.argv.slice(2);
if (args.includes('app-server')) args.push('--enable', 'default_mode_request_user_input', '-c', ${JSON.stringify(mcpOverride)});
const child = spawn(${JSON.stringify(process.env.CODEX_EXECUTABLE || "codex")}, args, { stdio: ['inherit', 'pipe', 'inherit'], env: process.env });
let pending = '';
child.stdout.on('data', (chunk) => {
  process.stdout.write(chunk); pending += chunk.toString();
  const lines = pending.split('\\n'); pending = lines.pop();
  for (const line of lines) { try {
    const frame = JSON.parse(line);
    if (['item/tool/requestUserInput', 'mcpServer/elicitation/request'].includes(frame.method)) appendFileSync(${JSON.stringify(path.join(root, "native-input.jsonl"))}, JSON.stringify({ method: frame.method, params: frame.params }) + '\\n');
  } catch {} }
});
child.on('error', () => process.exit(1)); child.on('exit', (code) => process.exit(code ?? 1));
`);
  await chmod(wrapper, 0o700);
  const hub = await HubServer.start({ stateDir: path.join(root, "hub"), clientDir: path.resolve("dist"), managedBots: { entrypoint: path.resolve("../dist/src/index.js"), env: { ...process.env, CODEX_EXECUTABLE: wrapper } } });
  const phoneContext = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const phone = await phoneContext.newPage();
  const pair = async (device: Page) => {
    await device.goto(hub.url); await preparePairing(device, hub); await device.getByRole("button", { name: "配对此设备", exact: true }).click();
    await hub.auth.approve(await device.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
    await device.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" }); await waitForClientOnline(device);
  };
  const send = async (text: string) => { await page.getByRole("textbox", { name: "消息", exact: true }).fill(text); await page.getByRole("button", { name: "发送消息", exact: true }).click(); };
  // The phone composer shows Stop only while a reply is live; otherwise Stop is in More.
  const stopFromPhone = async () => {
    const live = phone.getByRole("button", { name: "停止当前轮次", exact: true });
    if (await live.isVisible()) await live.click(); else await mobileChatAction(phone, "停止当前轮次");
  };
  try {
    await pair(page);
    await clickAppAction(page, "新建 Bot", page.getByRole("button", { name: "新建 Bot", exact: true }));
    await page.getByLabel("Bot 名称", { exact: true }).fill("Codex 原生提问验收");
    await page.getByLabel("引擎", { exact: true }).selectOption("codex");
    await page.getByLabel("模型", { exact: true }).selectOption("gpt-6-astra");
    await page.getByLabel("推理强度（effort）").selectOption("low");
    await page.getByText("高级设置", { exact: true }).click(); await page.getByLabel("工作区（可选）", { exact: true }).fill(workspace);
    await page.getByRole("button", { name: "创建 Bot", exact: true }).click();
    await expect(page.getByText("Bot 已上线，可以开始对话。", { exact: true })).toBeVisible({ timeout: 15_000 });
    await page.getByRole("button", { name: "开始对话", exact: true }).click(); await pair(phone);
    const bot = (await hub.store.bots("owner"))[0]!, conversation = (await hub.store.conversations("owner"))[0]!;
    await selectConversation(phone, conversation.title);
    const complete = async (marker: string) => {
      await expect.poll(async () => (await hub.store.snapshot("owner", conversation.id)).messages.some((m) => m.authorType === "bot" && m.status === "complete" && blocksText(m.blocks).includes(marker)), { timeout: 90_000 }).toBe(true);
      await expect.poll(async () => (await hub.store.pendingForBot(bot.id)).length).toBe(0);
    };
    await send('这是临时客户端验收。必须使用原生 request_user_input 工具，只问“验收选择哪种颜色？”，单选“蓝色”和“绿色”，header 为“验收”。必须等待用户回答后只回复 CODEX_QUESTION_OK 和用户选择的颜色。不使用其他工具、不修改文件、不自行代答。');
    for (const device of [page, phone]) await expect(device.getByRole("radio", { name: "蓝色", exact: true })).toBeVisible({ timeout: 90_000 });
    await phone.getByRole("radio", { name: "蓝色", exact: true }).check();
    await phone.screenshot({ path: info.outputPath("codex-question-phone.png") });
    await phone.getByRole("button", { name: "提交", exact: true }).click(); await complete("CODEX_QUESTION_OK");
    for (const device of [page, phone]) {
      await expect(device.getByRole("button", { name: "提交", exact: true })).toHaveCount(0);
      await expect(device.locator('.message-blocks').filter({ hasText: "CODEX_QUESTION_OK" }).last()).toContainText("蓝色");
    }
    await send('再次使用原生 request_user_input 工具，只问“停止验收选择？”选项“继续”和“结束”。等待我回答，本轮不要使用其他工具。');
    await expect(phone.locator('.native-question input[type="radio"]').first()).toBeVisible({ timeout: 90_000 });
    await stopFromPhone();
    for (const device of [page, phone]) await expect(device.getByRole("button", { name: "提交", exact: true })).toHaveCount(0, { timeout: 15_000 });
    await expect.poll(async () => (await hub.store.pendingForBot(bot.id)).length).toBe(0);
    await send("停止后恢复验收，不调用任何工具，只回复 CODEX_AFTER_QUESTION_STOP_OK。"); await complete("CODEX_AFTER_QUESTION_STOP_OK");
    await page.screenshot({ path: info.outputPath("codex-question-stop-desktop.png") });
    // Exercise both native tool confirmation and the server's data form using
    // this temporary Bot's explicit normal mode. Keep the product default.
    await send("/yolo off"); await complete("已恢复普通审批流程");
    const confirmMcp = async () => {
      const choice = phone.getByRole("radio", { name: "允许本次", exact: true });
      await expect(choice).toBeVisible({ timeout: 90_000 });
      await choice.check();
      await phone.getByRole("button", { name: "提交", exact: true }).click();
    };
    await send('现在调用 acceptance MCP 的 create_probe 一次。如果工具是延迟加载的，可以先用 tool_search 搜索并加载 acceptance create_probe。它会向我弹出原生 MCP 表单，必须等待我作答，不能用 request_user_input 或文字提问代替，不要读取文件或运行命令。成功后用 [send-file:工具返回的绝对路径] 发送真实结果文件，正文只写 CODEX_MCP_FORM_OK。');
    await confirmMcp();
    for (const device of [page, phone]) await expect(device.getByRole("radio", { name: "蓝色", exact: true })).toBeVisible({ timeout: 90_000 });
    expect(await readFile(path.join(workspace, "mcp-form-result.txt"), "utf8").catch(() => "missing")).toBe("missing");
    await phone.getByRole("radio", { name: "蓝色", exact: true }).check();
    await phone.getByRole("button", { name: "下一题", exact: true }).click();
    await phone.locator('textarea[name="q1_other"]').fill("手机确认");
    await phone.screenshot({ path: info.outputPath("codex-mcp-form-phone.png") });
    await phone.getByRole("button", { name: "提交", exact: true }).click(); await complete("CODEX_MCP_FORM_OK");
    const expected = `CODEX_MCP_FORM_OK\n${nonce}\nblue\n手机确认\n`;
    for (const device of [page, phone]) {
      const file = device.getByRole("region", { name: "mcp-form-result.txt", exact: true }); await expect(file).toBeVisible();
      const download = device.waitForEvent("download"); await file.getByRole("button", { name: "另存为 mcp-form-result.txt", exact: true }).click();
      expect(await readFile((await (await download).path())!, "utf8")).toBe(expected);
    }
    await send("再次调用 acceptance MCP 的 create_probe，等待我填写表单。如果我停止则不要再试，不使用其他工具。");
    await confirmMcp();
    await expect(phone.getByRole("radio", { name: "蓝色", exact: true })).toBeVisible({ timeout: 90_000 });
    await stopFromPhone();
    for (const device of [page, phone]) await expect(device.getByRole("button", { name: "提交", exact: true })).toHaveCount(0, { timeout: 15_000 });
    await expect.poll(async () => (await hub.store.pendingForBot(bot.id)).length).toBe(0);
    await send("不使用任何工具，只回复 CODEX_MCP_STOP_OK。"); await complete("CODEX_MCP_STOP_OK");
    const receipts = (await readFile(path.join(root, "elicitation-receipts.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    expect(receipts.filter((r) => r.write)).toHaveLength(1);
    await writeFile(info.outputPath("live-codex-input.json"), JSON.stringify({ engine: "codex", cli: cliVersion, model: "gpt-6-astra", processFeature: "default_mode_request_user_input", pairedDevices: 2, phoneAnswerObserved: true, stoppedQuestionRetiredOnBoth: true, nextTurnCompleted: true, questionsInDefaultBypass: true, mcpInExplicitNormalMode: true, realMcpFormAnswered: true, mcpDownloadsVerified: 2, stoppedMcpFormWrites: 0 }, null, 2));
  } catch (error) {
    await writeFile(info.outputPath("native-input.jsonl"), await readFile(path.join(root, "native-input.jsonl"), "utf8").catch(() => ""));
    for (const bot of await hub.store.bots("owner")) await writeFile(info.outputPath("diagnostics.json"), JSON.stringify({ status: hub.botManager!.serviceStatus(bot.id), messages: await Promise.all((await hub.store.conversations("owner")).map((c) => hub.store.snapshot("owner", c.id))) }, null, 2));
    throw error;
  } finally { await phoneContext.close(); await page.close(); await hub.close(); await archiveAcceptanceThreads(root); await rm(root, { recursive: true, force: true }); }
});
