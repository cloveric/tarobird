import { preparePairing } from "./fixtures/pairing-invite.js";
import { clickAppAction } from "./fixtures/desktop-actions.js";
import { archiveAcceptanceThreads } from "../../tests/helpers/codex-acceptance.js";
import { selectConversation, waitForClientOnline } from "./fixtures/mobile.js";
import { test, expect, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HubServer } from "../../src/hub/server.js";
import { blocksText } from "../../src/client-protocol/index.js";

test("real Codex async free-text questions accept phone answers after normal completion", async ({ page, browser }, info) => {
  test.skip(process.env.TAROCUB_LIVE_CODEX_ASYNC !== "1", "requires explicit real-engine acceptance");
  const cliVersion = execFileSync(process.env.CODEX_EXECUTABLE || "codex", ["--version"], { encoding: "utf8" }).trim();
  test.setTimeout(240_000);
  const root = await mkdtemp(path.join(os.tmpdir(), "live-codex-async-"));
  const workspace = path.join(root, "workspace"); await mkdir(workspace);
  const wrapper = path.join(root, "codex-acceptance.cjs");
  // 0.159.3 exposes this native tool in Default mode behind a feature flag.
  // Enable it for this CLI process only; do not edit the operator's config.
  await writeFile(wrapper, `#!${process.execPath}
const { spawn } = require('node:child_process');
const { appendFileSync } = require('node:fs');
const args = process.argv.slice(2);
if (args.includes('app-server')) args.push('--enable', 'default_mode_request_user_input');
const child = spawn(${JSON.stringify(process.env.CODEX_EXECUTABLE || "codex")}, args, { stdio: ['inherit', 'pipe', 'inherit'], env: process.env });
let pending = '';
child.stdout.on('data', (chunk) => {
  process.stdout.write(chunk); pending += chunk.toString();
  const lines = pending.split('\\n'); pending = lines.pop();
  for (const line of lines) { try {
    const frame = JSON.parse(line);
    if (frame.method === 'item/completed' && frame.params?.item?.delivery === 'async') appendFileSync(${JSON.stringify(path.join(root, "native-input.jsonl"))}, JSON.stringify({ method: frame.method, params: frame.params }) + '\\n');
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
  try {
    await pair(page);
    await clickAppAction(page, "新建 Bot", page.getByRole("button", { name: "新建 Bot", exact: true }));
    await page.getByLabel("Bot 名称", { exact: true }).fill("Codex 异步提问验收");
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
    await send('这是临时 App 验收。请调用原生 request_user_input_async 工具，只问“资料中不确定的项目怎么处理？”，不要提供选项，让我自由填写。工具调用后本轮立即结束，回复“ASYNC_READY”，不要等待，不要调用其他工具。之后我回答时，只回复 ASYNC_ANSWER_OK 和我填写的答案。');
    for (const device of [page, phone]) await expect(device.locator('textarea[name="q0_other"]')).toBeVisible({ timeout: 90_000 });
    await complete("ASYNC_READY");
    await phone.locator('textarea[name="q0_other"]').fill("单独列出，等我确认后再合并");
    await phone.screenshot({ path: info.outputPath("real-async-question-phone.png") });
    await phone.getByRole("button", { name: "提交", exact: true }).click();
    await complete("ASYNC_ANSWER_OK");
    for (const device of [page, phone]) {
      await expect(device.getByRole("region", { name: "回答问题", exact: true })).toHaveCount(0);
      await expect(device.locator('.message-blocks').filter({ hasText: "ASYNC_ANSWER_OK" }).last()).toContainText("单独列出，等我确认后再合并");
    }
    const native = (await readFile(path.join(root, "native-input.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
    expect(native.some(frame => frame.params.item.questions?.some((q: { title?: string; options?: unknown[] }) => q.title?.includes("不确定") && !q.options?.length))).toBe(true);
    await phone.screenshot({ path: info.outputPath("real-async-answer-phone.png") });
    await writeFile(info.outputPath("live-codex-async.json"), JSON.stringify({ engine: "codex", cli: cliVersion, model: "gpt-6-astra", pairedDevices: 2, nativeAsyncFreeText: true, normalOriginCompleted: true, phoneAnswerObserved: true, answeredOnce: true }, null, 2));
  } catch (error) {
    await writeFile(info.outputPath("native-input.jsonl"), await readFile(path.join(root, "native-input.jsonl"), "utf8").catch(() => ""));
    for (const bot of await hub.store.bots("owner")) await writeFile(info.outputPath("diagnostics.json"), JSON.stringify({ status: hub.botManager!.serviceStatus(bot.id), messages: await Promise.all((await hub.store.conversations("owner")).map((c) => hub.store.snapshot("owner", c.id))) }, null, 2));
    throw error;
  } finally { await phoneContext.close(); await page.close(); await hub.close(); await archiveAcceptanceThreads(root); await rm(root, { recursive: true, force: true }); }
});
