import { preparePairing } from "./fixtures/pairing-invite.js";
import { clickAppAction } from "./fixtures/desktop-actions.js";
import { selectConversation, waitForClientOnline } from "./fixtures/mobile.js";
import { test, expect, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { archiveAcceptanceThreads } from "../../tests/helpers/codex-acceptance.js";
import { HubServer } from "../../src/hub/server.js";
import { blocksText } from "../../src/client-protocol/index.js";

const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
test.use({ actionTimeout: 15_000 });
test("real Codex selects App file tools, preserves them on restart and delivers exact bytes to both clients", async ({ page, browser }, info) => {
  test.skip(process.env.TAROCUB_LIVE_APP_TOOLS !== "1", "requires explicit authenticated real-model acceptance");
  test.setTimeout(300_000);
  const executable = process.env.CODEX_EXECUTABLE || "codex";
  const cli = execFileSync(executable, ["--version"], { encoding: "utf8" }).trim();
  const root = await mkdtemp(path.join(os.tmpdir(), "live-app-tools-"));
  const workspace = path.join(root, "workspace"); await mkdir(workspace);
  const nativeLog = path.join(root, "native-tools.jsonl"), wrapper = path.join(root, "codex-observer.cjs");
  // Transparent protocol observer. No tools, model output, prompts, configuration
  // or delivery results are injected/replaced. Only fixture-relevant RPC is logged.
  await writeFile(wrapper, `#!${process.execPath}
const { spawn } = require('node:child_process');
const { appendFileSync } = require('node:fs');
const record = (data) => appendFileSync(${JSON.stringify(nativeLog)}, JSON.stringify({ observerPid: process.pid, ...data }) + '\\n');
const child = spawn(${JSON.stringify(executable)}, process.argv.slice(2), { stdio: ['pipe', 'pipe', 'inherit'], env: process.env });
const calls = new Map();
function observe(stream, direction, forward) {
  let pending = '';
  stream.on('data', (chunk) => {
    forward.write(chunk); pending += chunk.toString();
    const lines = pending.split('\\n'); pending = lines.pop();
    for (const line of lines) { try {
      const frame = JSON.parse(line);
      if (direction === 'out' && frame.method === 'item/tool/call') {
        calls.set(frame.id, frame.params);
        record({ type: 'tool-call', params: frame.params });
      }
      if (direction === 'in' && calls.has(frame.id) && !frame.method) {
        const call = calls.get(frame.id); calls.delete(frame.id);
        record({ type: 'tool-result', tool: call.tool, callId: call.callId, result: frame.result, error: frame.error });
      }
      if (direction === 'in' && ['thread/start', 'thread/resume'].includes(frame.method)) {
        record({ type: 'thread-request', method: frame.method, threadId: frame.params?.threadId, tools: frame.params?.dynamicTools?.map((tool) => tool.name) });
      }
    } catch {} }
  });
}
observe(process.stdin, 'in', child.stdin); observe(child.stdout, 'out', process.stdout);
process.stdin.on('end', () => child.stdin.end());
child.stdin.on('error', () => {});
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => child.kill(signal));
child.on('error', () => process.exit(1)); child.on('exit', (code) => process.exit(code ?? 1));
`);
  await chmod(wrapper, 0o700);
  const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve("dist"), managedBots: { entrypoint: path.resolve("../dist/src/index.js"), env: { ...process.env, CODEX_EXECUTABLE: wrapper } } });
  const phoneContext = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const phone = await phoneContext.newPage();
  const nativeFrames = async (): Promise<any[]> => (await readFile(nativeLog, "utf8").catch(() => "")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const pair = async (device: Page) => {
    await device.goto(hub.url); await preparePairing(device, hub); await device.getByRole("button", { name: "配对此设备", exact: true }).click();
    await hub.auth.approve(await device.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
    await device.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" });
    await waitForClientOnline(device);
  };
  const downloads: { revision: number; device: string; bytes: number; sha256: string }[] = [];
  let evidence: Record<string, unknown> | undefined;
  try {
    await pair(page);
    await clickAppAction(page, "新建 Bot", page.getByRole("button", { name: "新建 Bot", exact: true }));
    await page.getByLabel("Bot 名称", { exact: true }).fill("App 原生文件验收");
    await page.getByLabel("引擎", { exact: true }).selectOption("codex");
    await page.getByLabel("模型", { exact: true }).selectOption("gpt-6-astra");
    await page.getByLabel("推理强度（effort）").selectOption("low");
    await page.getByText("高级设置", { exact: true }).click();
    await page.getByLabel("工作区（可选）", { exact: true }).fill(workspace);
    await page.getByRole("button", { name: "创建 Bot", exact: true }).click();
    await expect(page.getByText("Bot 已上线，可以开始对话。", { exact: true })).toBeVisible({ timeout: 15_000 });
    await page.getByRole("button", { name: "开始对话", exact: true }).click(); await pair(phone);
    const bot = (await hub.store.bots("owner"))[0]!, conversation = (await hub.store.conversations("owner"))[0]!;
    await selectConversation(phone, conversation.title);
    const stateDir = path.join(root, "bots", bot.id), artifact = path.join(workspace, "native-delivery.txt");
    const theme = `琥珀风车${randomBytes(6).toString("hex")}`;
    const pid = () => Number(hub.botManager!.serviceStatus(bot.id).text.match(/PID: (\d+)/)?.[1] ?? 0);
    const sessionId = async () => {
      const state = JSON.parse(await readFile(path.join(stateDir, "session.json"), "utf8"));
      return state.chats.find((s: { conversationKey: string }) => s.conversationKey === `lark:${conversation.id}`)?.codexSessionId ?? "";
    };
    const send = async (text: string) => { await page.getByRole("textbox", { name: "消息", exact: true }).fill(text); await page.getByRole("button", { name: "发送消息", exact: true }).click(); };
    const completed = async (marker: string) => {
      await expect.poll(async () => (await hub.store.snapshot("owner", conversation.id)).messages.some((m) => m.authorType === "bot" && m.status === "complete" && blocksText(m.blocks).includes(marker)), { timeout: 100_000 }).toBe(true);
      await expect.poll(async () => (await hub.store.pendingForBot(bot.id)).length).toBe(0);
    };
    const verifyDelivery = async (revision: number, expected: string) => {
      const caption = `APP_FILE_V${revision}`;
      await completed(caption);
      const messages = (await hub.store.snapshot("owner", conversation.id)).messages.filter((m) => m.authorType === "bot" && m.blocks.some((b) => b.type === "file" && b.name === "native-delivery.txt"));
      expect(messages).toHaveLength(revision);
      const matches = messages.filter((m) => blocksText(m.blocks).includes(caption)); expect(matches).toHaveLength(1);
      const message = matches[0]!;
      expect(await readFile(artifact, "utf8")).toBe(expected);
      for (const [device, name] of [[page, "desktop"], [phone, "phone"]] as const) {
        const row = device.locator(`[data-message-id="${message.id}"]`);
        await expect(row).toContainText(caption);
        const file = row.getByRole("region", { name: "native-delivery.txt", exact: true }); await expect(file).toBeVisible();
        const download = device.waitForEvent("download"); await file.getByRole("button", { name: "另存为 native-delivery.txt", exact: true }).click();
        const bytes = await readFile((await (await download).path())!); expect(bytes.toString("utf8")).toBe(expected);
        downloads.push({ revision, device: name, bytes: bytes.length, sha256: hash(bytes) });
      }
      const frames = await nativeFrames();
      const call = frames.find((frame) => frame.type === "tool-call" && frame.params.tool === "app_send_file" && frame.params.arguments.caption === caption);
      expect(call).toBeTruthy(); expect(call.params.arguments).toMatchObject({ path: artifact, kind: "file" });
      const response = frames.find((frame) => frame.type === "tool-result" && frame.callId === call.params.callId);
      expect(response?.result?.success).toBe(true);
      expect(JSON.parse(response.result.contentItems[0].text)).toMatchObject({ delivered: true, messageId: message.id, sha256: hash(expected), size: Buffer.byteLength(expected) });
      const key = `app-file:${conversation.id}:${call.params.threadId}:${call.params.callId}`;
      const receipt = JSON.parse(await readFile(path.join(stateDir, "gateway-receipts", `${hash(key)}.json`), "utf8"));
      expect(receipt).toMatchObject({ state: "complete", result: { ok: true, result: { delivered: true, messageId: message.id, sha256: hash(expected) } } });
      const timeline = (await readFile(path.join(stateDir, "timeline.log.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
      expect(timeline.filter((event) => event.type === "file.accepted" && event.metadata?.via === "app_send_file" && event.metadata?.messageId === message.id)).toHaveLength(1);
    };
    const first = "App 原生文件交付\nversion=1\n你好，桌面和手机。\n";
    // No tool names or legacy marker syntax in the user's request: the model
    // must choose the registered native tool from the real platform contract.
    await send(`这是临时 App 验收。本次绘画主题是${theme}，请记住但不要写进文件。在 ${artifact} 创建 UTF-8 文件，内容严格为下面的三行（最后也保留换行），然后作为当前对话的可下载附件发给我，附件说明为 APP_FILE_V1。不要发到任何外部平台。\n\n${first}`);
    await verifyDelivery(1, first);
    const originalSession = await sessionId(); expect(originalSession).not.toBe("");
    const registrationPath = path.join(stateDir, "app-tool-threads", `${hash(originalSession)}.json`);
    const registration = await readFile(registrationPath, "utf8"); expect(JSON.parse(registration).toolVersion).toMatch(/^[a-f0-9]{64}$/);
    const firstPid = pid(); expect(firstPid).toBeGreaterThan(1); await hub.botManager!.restart(bot.id);
    await expect.poll(pid, { timeout: 15_000 }).not.toBe(firstPid);
    await expect.poll(pid, { timeout: 15_000 }).toBeGreaterThan(1);
    await expect.poll(async () => (await hub.store.bots("owner"))[0]?.online, { timeout: 15_000 }).toBe(1);
    const second = "App 原生文件交付\nversion=2\n同一路径更新后，桌面和手机都应收到新版。\n";
    await send(`将刚才的同一个文件覆盖为以下三行（最后保留换行），再把新版作为附件发到当前对话，附件说明为 APP_FILE_V2。不要发送外部消息。交付后请说出我上轮指定的绘画主题，并在末尾写 APP_RESUME_OK。\n\n${second}`);
    await verifyDelivery(2, second); await completed("APP_RESUME_OK");
    const resumed = (await hub.store.snapshot("owner", conversation.id)).messages.find((m) => m.authorType === "bot" && m.status === "complete" && blocksText(m.blocks).includes("APP_RESUME_OK"));
    expect(blocksText(resumed!.blocks)).toContain(theme);
    expect(await sessionId()).toBe(originalSession); expect(await readFile(registrationPath, "utf8")).toBe(registration);
    await send("先查询这个 App 关于文件交付的按需能力说明，再告诉我文件与说明文字是否能一起发送。仅查询说明，不修改或发送文件，不使用外部服务。回答末尾写 APP_CAPABILITY_OK。");
    await completed("APP_CAPABILITY_OK");
    const frames = await nativeFrames();
    expect(frames.filter((frame) => frame.type === "thread-request" && frame.method === "thread/start")).toHaveLength(1);
    expect(frames.some((frame) => frame.type === "thread-request" && frame.method === "thread/start" && frame.tools?.includes("app_send_file") && frame.tools?.includes("app_capability"))).toBe(true);
    expect(frames.some((frame) => frame.type === "thread-request" && frame.method === "thread/resume" && frame.threadId === originalSession)).toBe(true);
    const capability = frames.find((frame) => frame.type === "tool-call" && frame.params.tool === "app_capability" && frame.params.arguments.topic === "files");
    expect(capability).toBeTruthy();
    expect(frames.find((frame) => frame.type === "tool-result" && frame.callId === capability.params.callId)?.result.success).toBe(true);
    expect(new Set(frames.filter((frame) => frame.type === "tool-call" && frame.params.tool === "app_send_file").map((frame) => frame.observerPid)).size).toBe(2);
    expect((await hub.store.snapshot("owner", conversation.id)).messages.filter((m) => m.authorType === "bot" && m.blocks.some((b) => b.type === "file"))).toHaveLength(2);
    for (const [device, name] of [[page, "desktop"], [phone, "phone"]] as const) await device.screenshot({ path: info.outputPath(`native-tools-${name}.png`), animations: "disabled" });
    evidence = { testedAt: new Date().toISOString(), cli, model: "gpt-6-astra", effort: "low", pairedBrowserContexts: 2, physicalDevices: false, createdThroughUI: true, transparentObserver: true, toolNamesAbsentFromUserPrompts: true, legacyMarkersAbsentFromUserPrompts: true, modelCreatedFile: true, nativeFileDeliveries: 2, duplicateAttachments: 0, captionInAttachmentMessage: true, downloads, durableReceiptsVerified: 2, nativeAcceptedTimelineEvents: 2, restartedWorker: true, sameNativeSession: true, contextRemembered: true, toolRegistrationPreserved: true, samePathUpdatedBytesVerified: true, capabilityFilesToolCalled: true, modelTurns: 3 };
  } catch (error) {
    await writeFile(info.outputPath("diagnostics.json"), JSON.stringify({ bots: await hub.store.bots("owner"), snapshots: await Promise.all((await hub.store.conversations("owner")).map((c) => hub.store.snapshot("owner", c.id))), nativeFrames: await nativeFrames() }, null, 2));
    throw error;
  } finally {
    await phoneContext.close(); await page.close(); await hub.close();
    const archivedSessions = await archiveAcceptanceThreads(root);
    await writeFile(info.outputPath("cleanup.json"), JSON.stringify({ archivedSessions, readBackNoVisibleFixtureSessions: true }));
    if (evidence) await writeFile(info.outputPath("live-app-tools.json"), JSON.stringify({ ...evidence, archivedSessions, readBackNoVisibleFixtureSessions: true }, null, 2));
    await rm(root, { recursive: true, force: true });
  }
});
