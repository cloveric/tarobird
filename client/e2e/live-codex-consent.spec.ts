import { test, expect, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { blocksText } from "../../src/client-protocol/index.js";
import { HubServer } from "../../src/hub/server.js";
import { archiveAcceptanceThreads } from "../../tests/helpers/codex-acceptance.js";
import { preparePairing } from "./fixtures/pairing-invite.js";
import { clickAppAction } from "./fixtures/desktop-actions.js";
import { mobileChatAction, selectConversation, waitForClientOnline } from "./fixtures/mobile.js";

test("native Codex MCP consent preserves scopes across desktop and phone", async ({ page, browser }, info) => {
  test.skip(process.env.TAROBIRD_LIVE_CODEX_CONSENT !== "1", "requires explicit real-engine acceptance");
  test.setTimeout(300_000);
  const cli = process.env.CODEX_EXECUTABLE || "codex";
  const version = execFileSync(cli, ["--version"], { encoding: "utf8" }).trim();
  const root = await mkdtemp(path.join(os.tmpdir(), "live-codex-consent-"));
  const workspace = path.join(root, "workspace"); await mkdir(workspace);
  const override = `mcp_servers.consent_fixture={command=${JSON.stringify(process.execPath)},args=${JSON.stringify([path.resolve("e2e/fixtures/live-consent-mcp.mjs"), root])},tool_timeout_sec=120}`;
  const wrapper = path.join(root, "codex-consent.cjs");
  await writeFile(wrapper, `#!${process.execPath}
const { spawn } = require('node:child_process');
const { appendFileSync } = require('node:fs');
const args = process.argv.slice(2);
if (args.includes('app-server')) args.push('-c', ${JSON.stringify(override)});
const child = spawn(${JSON.stringify(cli)}, args, { stdio: ['inherit', 'pipe', 'inherit'], env: process.env });
let pending = '';
child.stdout.on('data', chunk => {
  process.stdout.write(chunk); pending += chunk.toString();
  const lines = pending.split('\\n'); pending = lines.pop();
  for (const line of lines) { try {
    const f = JSON.parse(line);
    if (f.method === 'mcpServer/elicitation/request') appendFileSync(${JSON.stringify(path.join(root, "native-consent.jsonl"))}, JSON.stringify(f.params) + '\\n');
  } catch {} }
});
child.on('error', () => process.exit(1)); child.on('exit', code => process.exit(code ?? 1));
`);
  await chmod(wrapper, 0o700);
  const hub = await HubServer.start({ stateDir: path.join(root, "hub"), clientDir: path.resolve("dist"), managedBots: { entrypoint: path.resolve("../dist/src/index.js"), env: { ...process.env, CODEX_EXECUTABLE: wrapper } } });
  const phoneContext = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const phone = await phoneContext.newPage();
  const pair = async (device: Page) => {
    await device.goto(hub.url); await preparePairing(device, hub);
    await device.getByRole("button", { name: "配对此设备", exact: true }).click();
    await hub.auth.approve(await device.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
    await device.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" }); await waitForClientOnline(device);
  };
  const receipts = async () => (await readFile(path.join(root, "consent-receipts.jsonl"), "utf8").catch(() => "")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  try {
    await pair(page);
    await clickAppAction(page, "新建 Bot", page.getByRole("button", { name: "新建 Bot", exact: true }));
    await page.getByLabel("Bot 名称", { exact: true }).fill("浏览器授权验收");
    await page.getByLabel("引擎", { exact: true }).selectOption("codex");
    await page.getByLabel("模型", { exact: true }).selectOption("gpt-6-astra");
    await page.getByLabel("推理强度（effort）").selectOption("low");
    await page.getByText("高级设置", { exact: true }).click();
    await page.getByLabel("工作区（可选）", { exact: true }).fill(workspace);
    await page.getByRole("button", { name: "创建 Bot", exact: true }).click();
    await expect(page.getByText("Bot 已上线，可以开始对话。", { exact: true })).toBeVisible({ timeout: 15_000 });
    await page.getByRole("button", { name: "开始对话", exact: true }).click();
    await pair(phone);
    const bot = (await hub.store.bots("owner"))[0]!, conversation = (await hub.store.conversations("owner"))[0]!;
    await selectConversation(phone, conversation.title);
    // The native CLI auto-accepts empty MCP tool consent under approvalPolicy
    // "never". Exercise requests actually delivered to the host without
    // changing the product's default or another Bot's settings.
    await page.getByRole("textbox", { name: "消息", exact: true }).fill("/yolo off");
    await page.getByRole("button", { name: "发送消息", exact: true }).click();
    await expect.poll(async () => (await hub.store.snapshot("owner", conversation.id)).messages.some((m) => m.authorType === "bot" && m.status === "complete" && blocksText(m.blocks).includes("已恢复普通审批流程")), { timeout: 15_000 }).toBe(true);

    const prompt = '调用 consent_fixture MCP 的 consent_probe 恰好一次。如果未加载，可用 tool_search 查找。等待工具的原生表单回答，不要用其他问题工具代替，不要自己作答，不调用浏览器、不读取或修改文件。工具结束后只回复 CONSENT_PROBE_DONE。';
    for (const [index, choice] of ["允许本次", "本会话允许", "始终允许", "拒绝", "stop"].entries()) {
      const before = new Set((await hub.store.snapshot("owner", conversation.id)).messages.map((m) => m.id));
      await page.getByRole("textbox", { name: "消息", exact: true }).fill(prompt);
      await page.getByRole("button", { name: "发送消息", exact: true }).click();
      for (const device of [page, phone]) {
        await expect(device.getByRole("radio", { name: "始终允许", exact: true })).toBeVisible({ timeout: 90_000 });
        await expect(device.getByText("App: Example Browser", { exact: false }).last()).toBeVisible();
      }
      expect(await receipts()).toHaveLength(index);
      if (choice === "stop") {
        const stop = phone.getByRole("button", { name: "停止当前轮次", exact: true });
        if (await stop.isVisible()) await stop.click(); else await mobileChatAction(phone, "停止当前轮次");
      } else {
        await phone.getByRole("radio", { name: choice, exact: true }).check();
        if (choice === "始终允许") {
          await phone.screenshot({ path: info.outputPath("consent-phone.png") });
          await page.screenshot({ path: info.outputPath("consent-desktop.png") });
        }
        await phone.getByRole("button", { name: "提交", exact: true }).click();
      }
      await expect.poll(async () => (await receipts()).length).toBe(index + 1);
      const received = (await receipts())[index];
      expect(received.action).toBe(choice === "stop" ? "cancel" : choice === "拒绝" ? "decline" : "accept");
      expect(received._meta?.persist).toBe(choice === "本会话允许" ? "session" : choice === "始终允许" ? "always" : undefined);
      for (const device of [page, phone]) await expect(device.getByRole("button", { name: "提交", exact: true })).toHaveCount(0);
      if (choice !== "stop") await expect.poll(async () => (await hub.store.snapshot("owner", conversation.id)).messages.some((m) => !before.has(m.id) && m.authorType === "bot" && m.status === "complete" && blocksText(m.blocks).includes("CONSENT_PROBE_DONE")), { timeout: 90_000 }).toBe(true);
      await expect.poll(async () => (await hub.store.pendingForBot(bot.id)).length).toBe(0);
    }
    await writeFile(info.outputPath("consent-receipts.json"), JSON.stringify({ cli: version, pairedDevices: 2, approvalMode: "normal", received: await receipts() }, null, 2));
  } finally {
    await writeFile(info.outputPath("native-consent.jsonl"), await readFile(path.join(root, "native-consent.jsonl"), "utf8").catch(() => ""));
    await phoneContext.close(); await page.close(); await hub.close(); await archiveAcceptanceThreads(root);
    await rm(root, { recursive: true, force: true });
  }
});
