import { preparePairing } from "./fixtures/pairing-invite.js";
import { clickAppAction } from "./fixtures/desktop-actions.js";
import { selectConversation, waitForClientOnline } from "./fixtures/mobile.js";
import { test, expect, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { HubServer } from "../../src/hub/server.js";
import { blocksText, type CardElement } from "../../src/client-protocol/index.js";
import { writeClaudeObserver, ownClaudeFixtureTranscripts } from "./fixtures/claude-app-observer.js";
import { mediaBatchFixture } from "./fixtures/media-batch.js";

const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
test.use({ actionTimeout: 15_000 });
test("real Claude chooses native batch delivery for ten images and a PDF with exact downloads on both clients", async ({ page, browser }, info) => {
  test.skip(process.env.TAROCUB_LIVE_CLAUDE_APP_TOOLS !== "1", "requires explicit authenticated real-model acceptance");
  test.setTimeout(300_000);
  const executable = process.env.CLAUDE_EXECUTABLE || "claude";
  const cli = execFileSync(executable, ["--version"], { encoding: "utf8" }).trim();
  const fixture = await mediaBatchFixture();
  const root = await mkdtemp(path.join(os.tmpdir(), "live-claude-app-tools-"));
  const workspace = path.join(root, "workspace"); await mkdir(workspace);
  const nativeLog = path.join(root, "native-tools.jsonl"), wrapper = path.join(root, "claude-observer.cjs");
  await writeClaudeObserver(wrapper, nativeLog, executable);
  const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve("dist"), managedBots: { entrypoint: path.resolve("../dist/src/index.js"), env: { ...process.env, CLAUDE_EXECUTABLE: wrapper } } });
  const phoneContext = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const phone = await phoneContext.newPage();
  const attachments = [...fixture.images.map(({ name, mimeType, buffer }) => ({ name, mimeType, buffer })), fixture.pdf];
  const pair = async (device: Page) => {
    await device.goto(hub.url); await preparePairing(device, hub); await device.getByRole("button", { name: "配对此设备", exact: true }).click();
    await hub.auth.approve(await device.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
    await device.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" }); await waitForClientOnline(device);
  };
  try {
    await pair(page);
    await clickAppAction(page, "新建 Bot", page.getByRole("button", { name: "新建 Bot", exact: true }));
    await page.getByLabel("Bot 名称", { exact: true }).fill("原生图集验收");
    await page.getByLabel("引擎", { exact: true }).selectOption("claude");
    await page.getByLabel("模型", { exact: true }).selectOption("sonnet");
    await page.getByLabel("推理强度（effort）").selectOption("low");
    await page.getByText("高级设置", { exact: true }).click(); await page.getByLabel("工作区（可选）", { exact: true }).fill(workspace);
    await page.getByRole("button", { name: "创建 Bot", exact: true }).click();
    await expect(page.getByText("Bot 已上线，可以开始对话。", { exact: true })).toBeVisible({ timeout: 15_000 });
    await page.getByRole("button", { name: "开始对话", exact: true }).click(); await pair(phone);
    const bot = (await hub.store.bots("owner"))[0]!, conversation = (await hub.store.conversations("owner"))[0]!;
    await selectConversation(phone, conversation.title);
    const prompt ='本次测试一起发送了 10 张 PNG 和 1 个 PDF。请实际读取全部附件：每张图内有 IMAGE 序号及一个八位编号，PDF 内有 PDF_CODE。把读取结果写入工作区 receipt.json，JSON 格式为 {"images":[{"number":1,"code":"图内编号"},…],"pdfCode":"PDF内编号"}。不要猜编号，不要修改原附件，不发送到外部平台。然后通过当前 App 的附件功能，将收到的十张 PNG 原样回传为一组带标题图集，各图标题依次为「验收图 01」至「验收图 10」，图集与文件在同一条消息中交付，同时回传原 PDF（说明「批次原始文档」）和 receipt.json（说明「批次读取结果」）。完成后回复 NATIVE_BATCH_OK。';
    await phone.getByRole("textbox", { name: "消息", exact: true }).fill(prompt);
    await phone.locator('input[type="file"][multiple]').setInputFiles(attachments);
    const draft = phone.getByRole("region", { name: "待发送的附件", exact: true });
    await expect(draft.getByRole("listitem")).toHaveCount(11); await expect(draft).toContainText("11 个附件");
    await phone.getByRole("button", { name: "发送消息", exact: true }).click();
    // Uploads finish sequentially before the atomic message is published. A
    // generic five-second assertion can tear down a healthy eleven-file send.
    await expect.poll(async () => (await hub.store.snapshot("owner", conversation.id)).messages.filter((m) => m.authorType === "user").length, { timeout: 30_000 }).toBe(1);
    const incoming = (await hub.store.snapshot("owner", conversation.id)).messages.find((m) => m.authorType === "user")!;
    expect(incoming.blocks.filter((b) => b.type === "image")).toHaveLength(10); expect(incoming.blocks.filter((b) => b.type === "file")).toHaveLength(1);
    expect(blocksText(incoming.blocks)).toContain(prompt);
    await expect.poll(async () => (await hub.store.snapshot("owner", conversation.id)).messages.some((m) => m.authorType === "bot" && m.status === "complete" && blocksText(m.blocks).includes("NATIVE_BATCH_OK")), { timeout: 180_000 }).toBe(true);
    await expect.poll(async () => (await hub.store.pendingForBot(bot.id)).length).toBe(0);
    const frames: any[] = (await readFile(nativeLog, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    const first = frames.find((frame) => frame.type === "input" && frame.files.length > 0)!; expect(first.files).toHaveLength(11);
    const inputHashes = await Promise.all(first.files.map(async (file: string) => hash(await readFile(file))));
    expect(inputHashes.sort()).toEqual(attachments.map((file) => hash(file.buffer)).sort());
    const reportSchema = z.object({ images: z.array(z.object({ number: z.number().int(), code: z.string() })).length(10), pdfCode: z.string() });
    const report = reportSchema.parse(JSON.parse(await readFile(path.join(workspace, "receipt.json"), "utf8")));
    expect(report.images.sort((a, b) => a.number - b.number)).toEqual(fixture.images.map(({ number, code }) => ({ number, code })));
    expect(report.pdfCode).toBe(fixture.pdfCode);
    const messages = (await hub.store.snapshot("owner", conversation.id)).messages.filter((m) => m.authorType === "bot");
    const walk = (elements: CardElement[]): CardElement[] => elements.flatMap((element) => [element, ...walk(element.children ?? [])]);
    const galleries = messages.flatMap((m) => m.blocks.flatMap((block) => block.type === "card" && walk(block.elements).filter((e) => e.type === "image").length ? [{ messageId: m.id, elements: walk(block.elements) }] : []));
    expect(galleries).toHaveLength(1);
    const galleryImages = galleries[0]!.elements.filter((e) => e.type === "image"); expect(galleryImages).toHaveLength(10);
    for (const [i, image] of galleryImages.entries()) {
      const file = await hub.attachments.download({ userId: "owner" }, image.attachmentId!);
      expect(hash(await readFile(file.path))).toBe(hash(fixture.images[i]!.buffer));
    }
    const batchCalls = frames.filter((entry) => entry.type === "mcp-request" && entry.frame.request.message.method === "tools/call" && entry.frame.request.message.params.name === "app_send_batch");
    expect(batchCalls).toHaveLength(1);
    const nativeCall = batchCalls[0].frame;
    const nativeResult = frames.find((entry) => entry.type === "mcp-response" && entry.frame.response.request_id === nativeCall.request_id)?.frame.response.response.mcp_response.result;
    expect(nativeResult?.isError).not.toBe(true);
    expect(JSON.parse(nativeResult.content[0].text)).toMatchObject({ delivered: true, messageId: galleries[0]!.messageId, files: expect.any(Array) });
    expect(JSON.parse(nativeResult.content[0].text).files).toHaveLength(12);
    const nativeSession = frames.find((entry) => entry.type === "session").sessionId;
    const receiptKey = `app-batch:${conversation.id}:${nativeSession}:${nativeCall.request.message.params._meta["claudecode/toolUseId"]}`;
    const savedReceipt = JSON.parse(await readFile(path.join(root, "bots", bot.id, "gateway-receipts", `${hash(Buffer.from(receiptKey))}.json`), "utf8"));
    expect(savedReceipt).toMatchObject({ state: "complete", result: { ok: true, result: { delivered: true, messageId: galleries[0]!.messageId } } });
    const returnedFiles = messages.flatMap((m) => m.blocks.flatMap((block) => block.type === "file" ? [{ messageId: m.id, block, text: blocksText(m.blocks) }] : []));
    expect(returnedFiles).toHaveLength(2);
    expect(returnedFiles.every((entry) => entry.messageId === galleries[0]!.messageId)).toBe(true);
    const pdf = returnedFiles.find((entry) => entry.block.name.endsWith(".pdf"))!, json = returnedFiles.find((entry) => entry.block.name === "receipt.json")!;
    expect(pdf.text).toContain("批次原始文档"); expect(json.text).toContain("批次读取结果");
    const receivedHashes: { device: string; images: string[]; pdf: string; report: string }[] = [];
    for (const [device, label] of [[page, "desktop"], [phone, "phone"]] as const) {
      const gallery = device.locator(`[data-message-id="${galleries[0]!.messageId}"] .image-grid`);
      await expect(gallery).toHaveCount(1); await expect(gallery.locator("figure")).toHaveCount(10);
      await expect(gallery.locator("figcaption")).toHaveText(fixture.images.map(({ number }) => `验收图 ${String(number).padStart(2, "0")}`));
      const imageHashes: string[] = [];
      for (const [index, img] of (await gallery.locator("img").all()).entries()) {
        await img.scrollIntoViewIfNeeded(); await expect.poll(() => img.evaluate((node) => (node as HTMLImageElement).naturalWidth)).toBe(600);
        // Read only this fixture attachment from the real browser cache. blob:
        // re-fetch is blocked by CSP; CDP returned empty response bodies for
        // these successful browser downloads, so neither is reliable evidence.
        const id = galleryImages[index]!.attachmentId!;
        imageHashes.push(await device.evaluate(async (attachmentId) => {
          const db = await new Promise<IDBDatabase>((resolve, reject) => { const request = indexedDB.open("tarocub-v1"); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
          try {
            const stored = await new Promise<Blob | { bytes: ArrayBuffer }>((resolve, reject) => { const request = db.transaction("attachmentData", "readonly").objectStore("attachmentData").get(attachmentId); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
            if (!stored) throw new Error("Expected fixture attachment absent from browser cache");
            const bytes = stored instanceof Blob ? await stored.arrayBuffer() : stored.bytes;
            return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (value) => value.toString(16).padStart(2, "0")).join("");
          } finally { db.close(); }
        }, id));
        if ([0, 3, 6, 9].includes(index)) {
          await gallery.locator("figure").nth(index).scrollIntoViewIfNeeded();
          await device.screenshot({ path: info.outputPath(`media-grid-${label}-${String(index + 1).padStart(2, "0")}.png`), animations: "disabled" });
        }
      }
      expect(imageHashes).toEqual(fixture.images.map((img) => hash(img.buffer)));
      const download = async (entry: typeof pdf) => {
        const target = device.locator(`[data-message-id="${entry.messageId}"]`).getByRole("region", { name: entry.block.name, exact: true });
        const received = device.waitForEvent("download"); await target.getByRole("button", { name: `另存为 ${entry.block.name}`, exact: true }).click();
        return readFile((await (await received).path())!);
      };
      const pdfBytes = await download(pdf), reportBytes = await download(json); expect(pdfBytes).toEqual(fixture.pdf.buffer);
      expect(reportSchema.parse(JSON.parse(reportBytes.toString("utf8")))).toEqual(report);
      receivedHashes.push({ device: label, images: imageHashes, pdf: hash(pdfBytes), report: hash(reportBytes) });
      expect(await device.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    }
    await writeFile(info.outputPath("live-native-batch.json"), JSON.stringify({ testedAt: new Date().toISOString(), engine: "claude", cli, model: "sonnet", effort: "low", phoneComposerInputCount: 11, atomicUserMessages: 1, nativeCliInputFiles: first.files.length, nativeCliInputHashesMatch: true, readEveryImageCode: true, readPdfCode: true, returnedImageGrids: 1, titledImages: 10, unchangedOriginalImages: true, unchangedOriginalPdf: true, reportFileParsed: true, pairedBrowserContexts: 2, physicalDevices: false, receivedHashes, toolNamesAbsentFromUserPrompt: true, nativeBatchCalls: batchCalls.length, durableReceiptVerified: true, deliveryProtocol: "Claude SDK MCP app_send_batch", cliSessionPersistence: false }, null, 2));
  } catch (error) {
    await phone.screenshot({ path: info.outputPath("failure-phone.png") }).catch(() => undefined);
    await writeFile(info.outputPath("diagnostics.json"), JSON.stringify({ snapshots: await Promise.all((await hub.store.conversations("owner")).map((c) => hub.store.snapshot("owner", c.id))), nativeFrames: await readFile(nativeLog, "utf8").catch(() => "") }, null, 2));
    throw error;
  } finally {
    await phoneContext.close(); await page.close(); await hub.close();
    await writeFile(info.outputPath("cleanup.json"), JSON.stringify({ cliSessionPersistence: false, ownedHubClosed: true }));
    await rm(root, { recursive: true, force: true });
  }
});

test("real Claude selects App file tools, preserves them on restart and delivers exact bytes to both clients", async ({ page, browser }, info) => {
  test.skip(process.env.TAROCUB_LIVE_CLAUDE_APP_TOOLS !== "1", "requires explicit authenticated real-model acceptance");
  test.setTimeout(300_000);
  const executable = process.env.CLAUDE_EXECUTABLE || "claude";
  const cli = execFileSync(executable, ["--version"], { encoding: "utf8" }).trim();
  const root = await mkdtemp(path.join(os.tmpdir(), "live-claude-app-tools-"));
  const workspace = path.join(root, "workspace"); await mkdir(workspace);
  const nativeLog = path.join(root, "native-tools.jsonl"), wrapper = path.join(root, "claude-observer.cjs");
  const cleanupTranscripts = await ownClaudeFixtureTranscripts(workspace);
  await writeClaudeObserver(wrapper, nativeLog, executable, true);
  const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve("dist"), managedBots: { entrypoint: path.resolve("../dist/src/index.js"), env: { ...process.env, CLAUDE_EXECUTABLE: wrapper } } });
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
    await page.getByLabel("引擎", { exact: true }).selectOption("claude");
    await page.getByLabel("模型", { exact: true }).selectOption("sonnet");
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
      const call = frames.find((entry) => entry.type === "mcp-request" && entry.frame.request.message.method === "tools/call" && entry.frame.request.message.params.name === "app_send_file" && entry.frame.request.message.params.arguments.caption === caption)?.frame;
      expect(call).toBeTruthy(); expect(call.request.message.params.arguments).toMatchObject({ path: artifact, kind: "file" });
      const result = frames.find((entry) => entry.type === "mcp-response" && entry.frame.response.request_id === call.request_id)?.frame.response.response.mcp_response.result;
      expect(result?.isError).not.toBe(true);
      expect(JSON.parse(result.content[0].text)).toMatchObject({ delivered: true, messageId: message.id, sha256: hash(expected), size: Buffer.byteLength(expected) });
      const key = `app-file:${conversation.id}:${await sessionId()}:${call.request.message.params._meta["claudecode/toolUseId"]}`;
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
    expect(frames.filter((frame) => frame.type === "launch").map((frame) => frame.resume)).toEqual([false, true]);
    expect(new Set(frames.filter((frame) => frame.type === "session").map((frame) => frame.sessionId))).toEqual(new Set([originalSession]));
    const capability = frames.find((entry) => entry.type === "mcp-request" && entry.frame.request.message.method === "tools/call" && entry.frame.request.message.params.name === "app_capability" && entry.frame.request.message.params.arguments.topic === "files")?.frame;
    expect(capability).toBeTruthy();
    expect(frames.find((entry) => entry.type === "mcp-response" && entry.frame.response.request_id === capability.request_id)?.frame.response.response.mcp_response.result.isError).not.toBe(true);
    expect((await hub.store.snapshot("owner", conversation.id)).messages.filter((m) => m.authorType === "bot" && m.blocks.some((b) => b.type === "file"))).toHaveLength(2);
    for (const [device, name] of [[page, "desktop"], [phone, "phone"]] as const) await device.screenshot({ path: info.outputPath(`native-tools-${name}.png`), animations: "disabled" });
    evidence = { testedAt: new Date().toISOString(), cli, engine: "claude", model: "sonnet", effort: "low", pairedBrowserContexts: 2, physicalDevices: false, createdThroughUI: true, transparentObserver: true, toolNamesAbsentFromUserPrompts: true, legacyMarkersAbsentFromUserPrompts: true, modelCreatedFile: true, nativeFileDeliveries: 2, duplicateAttachments: 0, captionInAttachmentMessage: true, downloads, durableReceiptsVerified: 2, nativeAcceptedTimelineEvents: 2, restartedWorker: true, sameNativeSession: true, contextRemembered: true, toolsReinitializedOnResume: true, samePathUpdatedBytesVerified: true, capabilityFilesToolCalled: true, modelTurns: 3 };
  } catch (error) {
    await writeFile(info.outputPath("diagnostics.json"), JSON.stringify({ bots: await hub.store.bots("owner"), snapshots: await Promise.all((await hub.store.conversations("owner")).map((c) => hub.store.snapshot("owner", c.id))), nativeFrames: await nativeFrames() }, null, 2));
    throw error;
  } finally {
    await phoneContext.close(); await page.close(); await hub.close();
    const frames = await nativeFrames();
    const sessions = [...new Set(frames.filter((frame) => frame.type === "session").map((frame) => frame.sessionId as string))];
    const launches = frames.filter((frame) => frame.type === "launch");
    await expect.poll(async () => launches.every((entry) => [entry.observerPid, entry.childPid].every((pid) => {
      if (!Number.isInteger(pid) || pid <= 1) return false;
      try { process.kill(pid, 0); return false; } catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
    })), { timeout: 15_000 }).toBe(true);
    const removedFixtureTranscripts = await cleanupTranscripts(sessions);
    if (evidence) expect(removedFixtureTranscripts).toBe(1);
    const cleanup = { removedFixtureTranscripts, readBackNoOwnedTranscripts: true, observerAndNativeChildrenStopped: true };
    await writeFile(info.outputPath("cleanup.json"), JSON.stringify(cleanup));
    if (evidence) await writeFile(info.outputPath("live-app-tools.json"), JSON.stringify({ ...evidence, ...cleanup }, null, 2));
    await rm(root, { recursive: true, force: true });
  }
});
