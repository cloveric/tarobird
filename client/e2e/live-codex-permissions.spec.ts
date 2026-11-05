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

test("real Codex extra permissions accept, deny and stop from a phone", async ({ page, browser }, info) => {
  test.skip(process.env.TAROCUB_LIVE_CODEX_PERMISSIONS !== "1", "requires explicit real-engine acceptance");
  const cli = execFileSync(process.env.CODEX_EXECUTABLE || "codex", ["--version"], { encoding: "utf8" }).trim();
  test.setTimeout(240_000);
  const root = await mkdtemp(path.join(os.tmpdir(), "live-codex-permissions-"));
  const workspace = path.join(root, "workspace"), target = path.join(root, "target");
  await mkdir(workspace); await mkdir(target);
  const nonce = randomBytes(16).toString("hex"), wrapper = path.join(root, "codex-permissions.cjs");
  // Scope all experimental feature and sandbox settings to this test process.
  await writeFile(wrapper, `#!${process.execPath}
const { spawn } = require('node:child_process');
const { appendFileSync } = require('node:fs');
const args = process.argv.slice(2);
if (args.includes('app-server')) args.push('--enable', 'request_permissions_tool', '-c', 'sandbox_mode="workspace-write"', '-c', 'sandbox_workspace_write.exclude_tmpdir_env_var=true', '-c', 'sandbox_workspace_write.exclude_slash_tmp=true', '-c', 'sandbox_workspace_write.network_access=false');
const child = spawn(${JSON.stringify(process.env.CODEX_EXECUTABLE || "codex")}, args, { stdio: ['inherit', 'pipe', 'inherit'], env: process.env });
let pending = '';
child.stdout.on('data', (chunk) => {
  process.stdout.write(chunk); pending += chunk.toString();
  const lines = pending.split('\\n'); pending = lines.pop();
  for (const line of lines) { try { const f = JSON.parse(line);
    if (f.method === 'item/permissions/requestApproval') appendFileSync(${JSON.stringify(path.join(root, "requests.jsonl"))}, JSON.stringify(f.params) + '\\n');
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
  const file = (name: string) => path.join(target, name + ".txt");
  const missing = async (name: string) => expect(await readFile(file(name), "utf8").catch(() => "missing")).toBe("missing");
  try {
    await pair(page); await clickAppAction(page, "新建 Bot", page.getByRole("button", { name: "新建 Bot", exact: true }));
    await page.getByLabel("Bot 名称", { exact: true }).fill("Codex 权限验收");
    await page.getByLabel("引擎", { exact: true }).selectOption("codex");
    await page.getByLabel("模型", { exact: true }).selectOption("gpt-6-astra");
    await page.getByLabel("推理强度（effort）").selectOption("low");
    await page.getByText("高级设置", { exact: true }).click(); await page.getByLabel("工作区（可选）", { exact: true }).fill(workspace);
    await page.getByRole("button", { name: "创建 Bot", exact: true }).click();
    await expect(page.getByText("Bot 已上线，可以开始对话。", { exact: true })).toBeVisible({ timeout: 20_000 });
    await page.getByRole("button", { name: "开始对话", exact: true }).click(); await pair(phone);
    const bot = (await hub.store.bots("owner"))[0]!, conversation = (await hub.store.conversations("owner"))[0]!;
    await selectConversation(phone, conversation.title);
    const complete = async (marker: string) => {
      await expect.poll(async () => (await hub.store.snapshot("owner", conversation.id)).messages.some((m) => m.authorType === "bot" && m.status === "complete" && blocksText(m.blocks).includes(marker)), { timeout: 90_000 }).toBe(true);
      await expect.poll(async () => (await hub.store.pendingForBot(bot.id)).length).toBe(0);
    };
    await send("/yolo off"); await complete("已恢复普通审批流程");
    const request = async (name: string, marker: string) => {
      await send(`这是隔离客户端验收。必须先调用原生 request_permissions，只申请 file_system.write=[${JSON.stringify(file(name))}]，不申请网络或其他路径。等待用户响应；如果授予权限，才用原生 shell 在该文件写入且只写入 ${nonce}，不要换用提权命令参数或其他工具绕过。如果拒绝或停止，不要写入、不重试。最后只回复 ${marker} 和实际结果。`);
      for (const device of [page, phone]) {
        await expect(device.getByRole("button", { name: "本轮允许", exact: true })).toBeVisible({ timeout: 90_000 });
        await expect(device.getByRole("button", { name: "本会话允许", exact: true })).toBeVisible();
        await expect(device.locator(".message-blocks code").filter({ hasText: file(name) })).toBeVisible();
      }
      await missing(name);
    };
    await request("allowed", "PERMISSION_ALLOW_OK");
    await phone.screenshot({ path: info.outputPath("codex-permission-phone.png") });
    await phone.getByRole("button", { name: "本轮允许", exact: true }).click(); await complete("PERMISSION_ALLOW_OK");
    expect(await readFile(file("allowed"), "utf8")).toBe(nonce);
    const completed = (await hub.store.snapshot("owner", conversation.id)).messages.find((m) => m.authorType === "bot" && m.status === "complete" && blocksText(m.blocks).includes("PERMISSION_ALLOW_OK"))!;
    expect(blocksText(completed.blocks)).not.toContain("⏳");
    await request("denied", "PERMISSION_DENIED_OK");
    await phone.getByRole("button", { name: "拒绝", exact: true }).click(); await complete("PERMISSION_DENIED_OK"); await missing("denied");
    await request("stopped", "PERMISSION_STOP_UNUSED");
    await stopFromPhone();
    for (const device of [page, phone]) await expect(device.getByRole("button", { name: "本轮允许", exact: true })).toHaveCount(0, { timeout: 15_000 });
    await expect.poll(async () => (await hub.store.pendingForBot(bot.id)).length).toBe(0);
    await send("不要使用工具，只回复 PERMISSION_AFTER_STOP_OK。"); await complete("PERMISSION_AFTER_STOP_OK"); await missing("stopped");
    const requests = (await readFile(path.join(root, "requests.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    expect(requests).toHaveLength(3);
    await page.screenshot({ path: info.outputPath("codex-permission-desktop.png") });
    await writeFile(info.outputPath("live-codex-permissions.json"), JSON.stringify({ engine: "codex", cli, model: "gpt-6-astra", processFeature: "request_permissions_tool", approvalMode: "normal", pairedDevices: 2, nativeRequests: requests.length, grantedTurnWriteVerified: true, deniedWriteAbsent: true, stoppedWriteAbsent: true, nextTurnCompleted: true, completedPermissionRowNotPending: true }, null, 2));
  } catch (error) {
    await writeFile(info.outputPath("native-permissions.jsonl"), await readFile(path.join(root, "requests.jsonl"), "utf8").catch(() => ""));
    for (const bot of await hub.store.bots("owner")) await writeFile(info.outputPath("diagnostics.json"), JSON.stringify({ status: hub.botManager!.serviceStatus(bot.id), messages: await Promise.all((await hub.store.conversations("owner")).map((c) => hub.store.snapshot("owner", c.id))) }, null, 2));
    throw error;
  } finally { await phoneContext.close(); await page.close(); await hub.close(); await archiveAcceptanceThreads(root); await rm(root, { recursive: true, force: true }); }
});
