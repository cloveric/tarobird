import { preparePairing } from "./fixtures/pairing-invite.js";
import { clickAppAction } from "./fixtures/desktop-actions.js";
import { selectConversation, waitForClientOnline } from "./fixtures/mobile.js";
import { test, expect, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HubServer } from "../../src/hub/server.js";
import { blocksText } from "../../src/client-protocol/index.js";
import { writeDeepSeekObserver } from "./fixtures/deepseek-app-observer.js";
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
test.use({ actionTimeout: 15_000 });
test("real DeepSeek selects App file tools, preserves them on restart and delivers exact bytes to both clients", async ({ page, browser }, info) => {
  test.skip(process.env.TAROCUB_LIVE_DEEPSEEK_APP_TOOLS !== "1", "requires explicit authenticated real-model acceptance");
  test.setTimeout(300_000);
  const executable = process.env.DSH_EXECUTABLE || "dsh";
  const cli = execFileSync(executable, ["--version"], { encoding: "utf8" }).trim();
  const root = await mkdtemp(path.join(os.tmpdir(), "live-deepseek-app-tools-"));
  const workspace = path.join(root, "workspace"); await mkdir(workspace);
  const nativeLog = path.join(root, "native-tools.jsonl"), wrapper = path.join(root, "deepseek-observer.cjs");
  await writeDeepSeekObserver(wrapper, nativeLog, executable);
  const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve("dist"), managedBots: { entrypoint: path.resolve("../dist/src/index.js"), env: { ...process.env, DSH_EXECUTABLE: wrapper } } });
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
    await page.getByLabel("引擎", { exact: true }).selectOption("deepseek");
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
      const call = frames.find((entry) => entry.type === "native" && entry.frame.type === "request" && entry.frame.method === "call" && entry.frame.payload.name === "app_send_file" && entry.frame.payload.arguments.caption === caption)?.frame;
      expect(call).toBeTruthy(); expect(call.payload.arguments).toMatchObject({ path: artifact, kind: "file" });
      const result = frames.find((entry) => entry.type === "host" && entry.frame.type === "response" && entry.frame.id === call.id)?.frame.result;
      expect(result?.isError).not.toBe(true);
      expect(JSON.parse(result.text)).toMatchObject({ delivered: true, messageId: message.id, sha256: hash(expected), size: Buffer.byteLength(expected) });
      const key = `app-file:${conversation.id}:${await sessionId()}:${call.payload.callId}`;
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
    const firstPid = pid(); expect(firstPid).toBeGreaterThan(1); await hub.botManager!.restart(bot.id);
    await expect.poll(pid, { timeout: 15_000 }).not.toBe(firstPid);
    await expect.poll(pid, { timeout: 15_000 }).toBeGreaterThan(1);
    await expect.poll(async () => (await hub.store.bots("owner"))[0]?.online, { timeout: 15_000 }).toBe(1);
    const second = "App 原生文件交付\nversion=2\n同一路径更新后，桌面和手机都应收到新版。\n";
    await send(`将刚才的同一个文件覆盖为以下三行（最后保留换行），再把新版作为附件发到当前对话，附件说明为 APP_FILE_V2。不要发送外部消息。交付后请说出我上轮指定的绘画主题，并在末尾写 APP_RESUME_OK。\n\n${second}`);
    await verifyDelivery(2, second); await completed("APP_RESUME_OK");
    const resumed = (await hub.store.snapshot("owner", conversation.id)).messages.find((m) => m.authorType === "bot" && m.status === "complete" && blocksText(m.blocks).includes("APP_RESUME_OK"));
    expect(blocksText(resumed!.blocks)).toContain(theme);
    expect(await sessionId()).toBe(originalSession);
    await send("先查询这个 App 关于文件交付的按需能力说明，再告诉我文件与说明文字是否能一起发送。仅查询说明，不修改或发送文件，不使用外部服务。回答末尾写 APP_CAPABILITY_OK。");
    await completed("APP_CAPABILITY_OK");
    const frames = await nativeFrames();
    expect(frames.filter((frame) => frame.type === "launch")).toHaveLength(2);
    const calls = frames.filter((entry) => entry.type === "native" && entry.frame.type === "request" && entry.frame.method === "call");
    expect(new Set(calls.map((entry) => entry.frame.payload.sessionId))).toEqual(new Set([originalSession]));
    const capability = calls.find((entry) => entry.frame.payload.name === "app_capability" && entry.frame.payload.arguments.topic === "files")?.frame;
    expect(capability).toBeTruthy();
    expect(frames.find((entry) => entry.type === "host" && entry.frame.type === "response" && entry.frame.id === capability.id)?.frame.result.isError).not.toBe(true);
    expect((await hub.store.snapshot("owner", conversation.id)).messages.filter((m) => m.authorType === "bot" && m.blocks.some((b) => b.type === "file"))).toHaveLength(2);
    const batchNote = "native batch member\n";
    await send(`在工作区创建 batch-note.txt，内容严格为 native batch member 加一个换行。然后将它和之前的 native-delivery.txt 作为同一条消息里的两个可下载附件一次性发给我，整条消息说明 APP_BATCH_OK。保留原文件内容，不发到任何外部平台。`);
    await completed("APP_BATCH_OK");
    const batchMessages = (await hub.store.snapshot("owner", conversation.id)).messages.filter((message) => message.authorType === "bot" && message.blocks.some((block) => block.type === "file" && block.name === "batch-note.txt"));
    expect(batchMessages).toHaveLength(1);
    const batchMessage = batchMessages[0]!, batchFiles = batchMessage.blocks.filter((block) => block.type === "file");
    expect(batchFiles).toHaveLength(2); expect(blocksText(batchMessage.blocks)).toContain("APP_BATCH_OK");
    for (const [device, name] of [[page, "desktop"], [phone, "phone"]] as const) {
      for (const file of batchFiles) {
        const target = device.locator(`[data-message-id="${batchMessage.id}"]`).getByRole("region", { name: file.name, exact: true });
        const download = device.waitForEvent("download"); await target.getByRole("button", { name: `另存为 ${file.name}`, exact: true }).click();
        const bytes = await readFile((await (await download).path())!); expect(bytes.toString("utf8")).toBe(file.name === "batch-note.txt" ? batchNote : second);
        downloads.push({ revision: 3, device: name, bytes: bytes.length, sha256: hash(bytes) });
      }
    }
    const batchFrames = await nativeFrames();
    const batchCalls = batchFrames.filter((entry) => entry.type === "native" && entry.frame.type === "request" && entry.frame.method === "call" && entry.frame.payload.name === "app_send_batch");
    expect(batchCalls).toHaveLength(1);
    const batchCall = batchCalls[0]!.frame, batchResult = batchFrames.find((entry) => entry.type === "host" && entry.frame.type === "response" && entry.frame.id === batchCall.id)?.frame.result;
    expect(batchResult.isError).not.toBe(true); expect(JSON.parse(batchResult.text)).toMatchObject({ delivered: true, messageId: batchMessage.id });
    const batchReceipt = JSON.parse(await readFile(path.join(stateDir, "gateway-receipts", `${hash(`app-batch:${conversation.id}:${originalSession}:${batchCall.payload.callId}`)}.json`), "utf8"));
    expect(batchReceipt).toMatchObject({ state: "complete", result: { ok: true, result: { delivered: true, messageId: batchMessage.id } } });
    for (const [device, name] of [[page, "desktop"], [phone, "phone"]] as const) await device.screenshot({ path: info.outputPath(`native-tools-${name}.png`), animations: "disabled" });
    evidence = { testedAt: new Date().toISOString(), cli, engine: "deepseek", model: "engine-default", effort: "low", pairedBrowserContexts: 2, physicalDevices: false, createdThroughUI: true, transparentObserver: true, toolNamesAbsentFromUserPrompts: true, legacyMarkersAbsentFromUserPrompts: true, modelCreatedFile: true, nativeFileDeliveries: 2, nativeBatchCalls: 1, atomicBatchFiles: 2, duplicateAttachments: 0, captionInAttachmentMessage: true, downloads, durableReceiptsVerified: 3, nativeAcceptedTimelineEvents: 2, restartedWorker: true, sameNativeSession: true, contextRemembered: true, toolsReinitializedOnResume: true, samePathUpdatedBytesVerified: true, capabilityFilesToolCalled: true, modelTurns: 4 };
  } catch (error) {
    await writeFile(info.outputPath("diagnostics.json"), JSON.stringify({ bots: await hub.store.bots("owner"), services: (await hub.store.bots("owner")).map((bot) => hub.botManager!.serviceStatus(bot.id)), snapshots: await Promise.all((await hub.store.conversations("owner")).map((c) => hub.store.snapshot("owner", c.id))), nativeFrames: await nativeFrames() }, null, 2));
    throw error;
  } finally {
    await phoneContext.close(); await page.close(); await hub.close();
    const frames = await nativeFrames();
    const launches = frames.filter((frame) => frame.type === "launch");
    await expect.poll(async () => launches.every((entry) => [entry.observerPid, entry.childPid].every((pid) => {
      if (!Number.isInteger(pid) || pid <= 1) return false;
      try { process.kill(pid, 0); return false; } catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
    })), { timeout: 15_000 }).toBe(true);
    const cleanup = { isolatedNativeHome: true, observerAndNativeChildrenStopped: true };
    await writeFile(info.outputPath("cleanup.json"), JSON.stringify(cleanup));
    if (evidence) await writeFile(info.outputPath("live-app-tools.json"), JSON.stringify({ ...evidence, ...cleanup }, null, 2));
    await rm(root, { recursive: true, force: true });
  }
});
