import { preparePairing } from "./fixtures/pairing-invite.js";
import { clickAppAction } from "./fixtures/desktop-actions.js";
import { mobileChatAction, selectConversation, waitForClientOnline } from "./fixtures/mobile.js";
import { test, expect, type Page } from "@playwright/test";
import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HubServer } from "../../src/hub/server.js";
import { blocksText } from "../../src/client-protocol/index.js";
import { HubPromptQueue } from "../../src/hub/prompt-queue.js";
import { execFileSync } from "node:child_process";

const engine = process.env.TAROCUB_LIVE_ENGINE ?? "claude";
if (process.env.TAROCUB_LIVE_TOOLS === "1" && !["claude", "kimi"].includes(engine)) throw new Error("live-tools supports claude or kimi");
const model = engine === "claude" ? "sonnet" : "";
test(`real ${engine} questions and MCP approvals settle across devices and return an exact file`, async ({ page, browser }, info) => {
  test.skip(process.env.TAROCUB_LIVE_TOOLS !== "1", "requires explicit real-engine acceptance");
  test.setTimeout(engine === "kimi" ? 540_000 : 300_000);
  const cliVersion = engine === "kimi" ? execFileSync(process.env.KIMI_EXECUTABLE || "kimi", ["--version"], { encoding: "utf8" }).trim() : undefined;
  const root = await mkdtemp(path.join(os.tmpdir(), "live-client-tools-"));
  const workspace = path.join(root, "workspace"); await mkdir(workspace);
  const nonce = randomBytes(16).toString("hex"); await writeFile(path.join(root, "nonce.txt"), nonce);
  const mcpConfig = path.join(root, "mcp.json");
  const mcpSettings = JSON.stringify({ mcpServers: { acceptance: { command: process.execPath, args: [path.resolve("e2e/fixtures/live-mcp.mjs"), root] } } });
  await writeFile(mcpConfig, mcpSettings);
  const kimiHome = path.join(root, "kimi-home");
  if (engine === "kimi") {
    await mkdir(path.join(workspace, ".kimi-code")); await writeFile(path.join(workspace, ".kimi-code", "mcp.json"), mcpSettings);
    // Native 2.1.1 predates KIMI_CODE_TRUST_WORKSPACE. Its trust record is a
    // fixture in a disposable home; never grant trust in the operator's home.
    // Reuse the existing login by reference, without reading/copying its values.
    await mkdir(path.join(kimiHome, "workspace-trust"), { recursive: true, mode: 0o700 });
    const nativeHome = process.env.KIMI_CODE_HOME ?? path.join(os.homedir(), ".kimi-code");
    await symlink(path.join(nativeHome, "config.toml"), path.join(kimiHome, "config.toml"));
    await symlink(path.join(nativeHome, "credentials"), path.join(kimiHome, "credentials"), "dir");
    const trustKey = `wd_workspace_${createHash("sha256").update(workspace).digest("hex").slice(0, 12)}`;
    await writeFile(path.join(kimiHome, "workspace-trust", trustKey), JSON.stringify({ root: workspace, trustedAt: Date.now() }), { mode: 0o600, flag: "wx" });
  }
  const wrapper = path.join(root, "claude-acceptance.cjs");
  const executable = process.env.CLAUDE_EXECUTABLE || "claude";
  // Per-process CLI configuration, never edit the shared login/configuration.
  // The real CLI performs model/tool calls; only the MCP endpoint is a fixture.
  const flags = ["--mcp-config", mcpConfig, "--strict-mcp-config", "--setting-sources", "", "--tools", "AskUserQuestion", "--permission-mode", "manual", "--settings", JSON.stringify({ permissions: { ask: ["mcp__acceptance__read_probe", "mcp__acceptance__write_probe"] } })];
  await writeFile(wrapper, `#!${process.execPath}
const { spawn } = require('node:child_process');
const child = spawn(${JSON.stringify(executable)}, [...process.argv.slice(2), ...${JSON.stringify(flags)}], { stdio: 'inherit', env: process.env });
child.on('error', () => process.exit(1));
child.on('exit', (code) => process.exit(code ?? 1));
`);
  await chmod(wrapper, 0o700);
  // Only this disposable, test-authored workspace is trusted for the headless
  // Kimi process. Preserve the operator's native trust settings elsewhere.
  const acceptanceEnv = engine === "claude" ? { CLAUDE_EXECUTABLE: wrapper } : { KIMI_CODE_HOME: kimiHome };
  const hub = await HubServer.start({ stateDir: path.join(root, "hub"), clientDir: path.resolve("dist"), managedBots: { entrypoint: path.resolve("../dist/src/index.js"), env: { ...process.env, ...acceptanceEnv } } });
  const phoneContext = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const phone = await phoneContext.newPage();
  const pair = async (device: Page) => {
    await device.goto(hub.url); await preparePairing(device, hub); await device.getByRole("button", { name: "配对此设备", exact: true }).click();
    await hub.auth.approve(await device.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
    await device.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" }); await waitForClientOnline(device);
  };
  const send = async (text: string) => { await page.getByRole("textbox", { name: "消息", exact: true }).fill(text); await page.getByRole("button", { name: "发送消息", exact: true }).click(); };
  const receipts = async (): Promise<{ tool: string }[]> => (await readFile(path.join(root, "mcp-receipts.jsonl"), "utf8").catch(() => "")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  try {
    await pair(page);
    await clickAppAction(page, "新建 Bot", page.getByRole("button", { name: "新建 Bot", exact: true }));
    await page.getByLabel("Bot 名称", { exact: true }).fill("真实工具验收助手");
    await page.getByLabel("引擎", { exact: true }).selectOption(engine);
    await page.getByLabel("模型", { exact: true }).selectOption(model);
    await page.getByLabel("推理强度（effort）").selectOption("low");
    await page.getByText("高级设置", { exact: true }).click(); await page.getByLabel("工作区（可选）", { exact: true }).fill(workspace);
    await page.getByRole("button", { name: "创建 Bot", exact: true }).click();
    await expect(page.getByText("Bot 已上线，可以开始对话。", { exact: true })).toBeVisible({ timeout: 15_000 });
    await page.getByRole("button", { name: "开始对话", exact: true }).click();
    await pair(phone);
    const bot = (await hub.store.bots("owner"))[0]!, conversation = (await hub.store.conversations("owner"))[0]!;
    await selectConversation(phone, conversation.title);
    const complete = async (marker: string) => {
      await expect.poll(async () => (await hub.store.snapshot("owner", conversation.id)).messages.some((m) => m.authorType === "bot" && m.status === "complete" && blocksText(m.blocks).includes(marker)), { timeout: 90_000 }).toBe(true);
      await expect.poll(async () => (await hub.store.pendingForBot(bot.id)).length).toBe(0);
    };
    await send("/yolo off"); await complete("已恢复普通审批流程");
    await send('这是临时验收。必须调用原生 AskUserQuestion 工具，只问一个问题“验收选择哪种颜色？”，选项“蓝色”和“绿色”，单选。不要用普通文字替代表单。等待用户选完后，只回复“QUESTION_OK”和选中的颜色。本轮不要使用其他工具。');
    for (const device of [page, phone]) await expect(device.getByRole("radio", { name: "蓝色", exact: true })).toBeVisible({ timeout: 90_000 });
    await phone.getByRole("radio", { name: "蓝色", exact: true }).check();
    await phone.screenshot({ path: info.outputPath("live-question-phone.png") });
    await phone.getByRole("button", { name: "提交", exact: true }).click();
    await complete("QUESTION_OK");
    for (const device of [page, phone]) await expect(device.getByRole("button", { name: "提交", exact: true }).filter({ visible: true })).toHaveCount(0);
    if (engine === "kimi") {
      // Only native choice answers: free-text "Other" remains outside Kimi's
      // ACP contract. A queued prompt must not steal the form's response.
      await send('这是临时验收。用一次原生 AskUserQuestion 调用同时提出两题：第一题单选 Alpha 或 Beta；第二题多选 Gamma 和 Delta。必须等待用户选择，之后只回复 KIMI_FORM_OK 和全部所选项。不要使用别的工具。');
      await expect(phone.getByRole("radio", { name: "Alpha", exact: true })).toBeVisible({ timeout: 90_000 });
      await send('这是下一轮排队验收，不调用工具，只回复 KIMI_QUEUE_OK。');
      const queue = new HubPromptQueue(hub.store);
      await expect.poll(async () => (await queue.read("owner", bot.id, conversation.id)).items.some(item => item.state === "queued" && blocksText(item.message.blocks).includes("KIMI_QUEUE_OK"))).toBe(true);
      await phone.getByRole("radio", { name: "Alpha", exact: true }).check();
      await phone.getByRole("button", { name: "下一题", exact: true }).click();
      for (const name of ["Gamma", "Delta"]) await phone.getByRole("checkbox", { name, exact: true }).check();
      await phone.getByRole("button", { name: "提交", exact: true }).click();
      await complete("KIMI_FORM_OK"); await complete("KIMI_QUEUE_OK");
      const answers = (await hub.store.snapshot("owner", conversation.id)).messages.filter(m => m.authorType === "bot" && m.status === "complete").map(m => blocksText(m.blocks));
      const form = answers.findIndex(text => text.includes("KIMI_FORM_OK"));
      expect(form).toBeGreaterThanOrEqual(0);
      for (const value of ["Alpha", "Gamma", "Delta"]) expect(answers[form]).toContain(value);
      expect(answers.findIndex(text => text.includes("KIMI_QUEUE_OK"))).toBeGreaterThan(form);
      await send('再次用原生 AskUserQuestion 提问“停止验收选择？”单选“继续”或“结束”。必须等待回答，不使用别的工具。');
      await expect(phone.getByRole("radio", { name: "继续", exact: true })).toBeVisible({ timeout: 90_000 });
      const stop = phone.getByRole("button", { name: "停止当前轮次", exact: true });
      if (await stop.isVisible()) await stop.click(); else await mobileChatAction(phone, "停止当前轮次");
      await expect(phone.locator('.native-question input[type=radio]')).toHaveCount(0, { timeout: 15_000 });
      await expect.poll(async () => (await hub.store.pendingForBot(bot.id)).length).toBe(0);
      await send('停止后恢复验收，不调用工具，只回复 KIMI_AFTER_STOP_OK。'); await complete("KIMI_AFTER_STOP_OK");
    }
    await send('继续临时本机验收。调用 acceptance MCP 的 read_probe 获取随机 nonce，再调用 write_probe，nonce 必须来自真实工具结果，color 用我刚选的颜色。工具会请求审批，请等待。写入成功后按照当前平台的文件交付说明，把工具返回路径的已生成文件作为附件发送，正文只写 TAROCUB_MCP_OK。不要调用其他工具或自己编造 nonce。');
    const approval = (device: Page, tool: string) => device.locator('.message-blocks').filter({ has: device.getByRole("button", { name: "允许一次", exact: true }) }).filter({ hasText: tool }).last();
    const firstApproval = await Promise.race([
      approval(page, "read_probe").waitFor({ state: "visible", timeout: 90_000 }).then(() => "read"),
      approval(page, "write_probe").waitFor({ state: "visible", timeout: 90_000 }).then(() => "write"),
    ]);
    if (engine === "claude") expect(firstApproval).toBe("read");
    if (firstApproval === "read") {
      expect(await receipts()).toEqual([]);
      await approval(page, "read_probe").getByRole("button", { name: "允许一次", exact: true }).click();
    }
    await expect(approval(phone, "write_probe")).toBeVisible({ timeout: 90_000 });
    expect(await receipts()).toEqual([{ tool: "read_probe" }]);
    await expect(approval(page, "write_probe")).toBeVisible();
    await phone.screenshot({ path: info.outputPath("live-approval-phone.png") });
    await approval(phone, "write_probe").getByRole("button", { name: "允许一次", exact: true }).click();
    await complete("TAROCUB_MCP_OK");
    const result = (await hub.store.snapshot("owner", conversation.id)).messages.find((m) => m.authorType === "bot" && blocksText(m.blocks).includes("TAROCUB_MCP_OK"))!;
    expect(blocksText(result.blocks)).toContain("过程 · 2 步");
    expect(blocksText(result.blocks)).not.toContain("⏳");
    const expected = `TAROCUB_MCP_OK\n${nonce}\n蓝色\n`;
    expect(await readFile(path.join(workspace, "acceptance-result.txt"), "utf8")).toBe(expected);
    for (const device of [page, phone]) {
      const file = device.getByRole("region", { name: "acceptance-result.txt", exact: true }); await expect(file).toBeVisible();
      const download = device.waitForEvent("download"); await file.getByRole("button", { name: "另存为 acceptance-result.txt", exact: true }).click();
      expect(await readFile((await (await download).path())!, "utf8")).toBe(expected);
      await expect(device.getByRole("button", { name: "允许一次", exact: true })).toHaveCount(0);
    }
    await send('最后一次验收：再次调用 write_probe，使用上一轮相同的参数。如果我拒绝审批，立即停止调用，不要重试或换工具，只回复 DENIED_OK。');
    await expect(approval(phone, "write_probe")).toBeVisible({ timeout: 90_000 });
    await approval(phone, "write_probe").getByRole("button", { name: "拒绝", exact: true }).click();
    await complete("DENIED_OK");
    expect((await receipts()).filter((r) => r.tool === "write_probe")).toHaveLength(1);
    await page.screenshot({ path: info.outputPath("live-tools-desktop.png") });
    const evidence = { engine, cliVersion, realModel: model || "native default", nativeProjectMcp: engine === "kimi", nativeChoiceFormQueueStop: engine === "kimi", readApprovedOnDesktop: firstApproval === "read", localMcp: true, pairedDevices: 2, nativeQuestionAnswered: true, approveBeforeWrite: true, rejectionPreventsWrite: true, writeInvocations: 1, downloadsVerified: 2 };
    await writeFile(info.outputPath("live-tools.json"), JSON.stringify(evidence, null, 2));
  } catch (error) {
    for (const bot of await hub.store.bots("owner")) await writeFile(info.outputPath("live-tools-diagnostics.json"), JSON.stringify({ status: hub.botManager!.serviceStatus(bot.id), receipts: await receipts(), messages: await Promise.all((await hub.store.conversations("owner")).map((c) => hub.store.snapshot("owner", c.id))) }, null, 2));
    throw error;
  } finally { await phoneContext.close(); await page.close(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});
