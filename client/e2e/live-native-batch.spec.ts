import { preparePairing } from "./fixtures/pairing-invite.js";
import { clickAppAction } from "./fixtures/desktop-actions.js";
import { selectConversation, waitForClientOnline } from "./fixtures/mobile.js";
import { test, expect, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { HubServer } from "../../src/hub/server.js";
import { blocksText, type CardElement } from "../../src/client-protocol/index.js";
import { archiveAcceptanceThreads } from "../../tests/helpers/codex-acceptance.js";
import { mediaBatchFixture } from "./fixtures/media-batch.js";

const hash = (value: Buffer) => createHash("sha256").update(value).digest("hex");
test.use({ actionTimeout: 15_000 });
test("real Codex chooses native batch delivery for ten images and a PDF with exact downloads on both clients", async ({ page, browser }, info) => {
  test.skip(process.env.TAROCUB_LIVE_NATIVE_BATCH !== "1", "requires explicit authenticated real-model acceptance");
  test.setTimeout(300_000);
  const executable = process.env.CODEX_EXECUTABLE || "codex";
  const cli = execFileSync(executable, ["--version"], { encoding: "utf8" }).trim();
  const fixture = await mediaBatchFixture();
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
      if (direction === 'in' && frame.method === 'turn/start') { record({ type: 'input', files: [...(frame.params?.input ?? []).filter((part) => part.type === 'text').map((part) => part.text).join('\\n').matchAll(/^Attachment: (.+)$/gm)].map((match) => match[1]) }); }
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
    await page.getByLabel("引擎", { exact: true }).selectOption("codex");
    await page.getByLabel("模型", { exact: true }).selectOption("gpt-6-astra");
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
    const batchCalls = frames.filter((frame) => frame.type === "tool-call" && frame.params.tool === "app_send_batch");
    expect(batchCalls).toHaveLength(1);
    const nativeResult = frames.find((frame) => frame.type === "tool-result" && frame.callId === batchCalls[0].params.callId);
    expect(nativeResult?.result.success).toBe(true);
    expect(JSON.parse(nativeResult.result.contentItems[0].text)).toMatchObject({ delivered: true, messageId: galleries[0]!.messageId, files: expect.any(Array) });
    expect(JSON.parse(nativeResult.result.contentItems[0].text).files).toHaveLength(12);
    const receiptKey = `app-batch:${conversation.id}:${batchCalls[0].params.threadId}:${batchCalls[0].params.callId}`;
    const savedReceipt = JSON.parse(await readFile(path.join(root, "bots", bot.id, "gateway-receipts", `${hash(Buffer.from(receiptKey))}.json`), "utf8"));
    expect(savedReceipt).toMatchObject({ state: "complete", result: { ok: true, result: { delivered: true, messageId: galleries[0]!.messageId } } });
    expect(frames.some((frame) => frame.type === "thread-request" && frame.method === "thread/start" && frame.tools?.includes("app_send_batch"))).toBe(true);
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
    await writeFile(info.outputPath("live-native-batch.json"), JSON.stringify({ testedAt: new Date().toISOString(), engine: "codex", cli, model: "gpt-6-astra", effort: "low", phoneComposerInputCount: 11, atomicUserMessages: 1, nativeCliInputFiles: first.files.length, nativeCliInputHashesMatch: true, readEveryImageCode: true, readPdfCode: true, returnedImageGrids: 1, titledImages: 10, unchangedOriginalImages: true, unchangedOriginalPdf: true, reportFileParsed: true, pairedBrowserContexts: 2, physicalDevices: false, receivedHashes, toolNamesAbsentFromUserPrompt: true, nativeBatchCalls: batchCalls.length, durableReceiptVerified: true, deliveryProtocol: "app_send_batch native dynamic tool" }, null, 2));
  } catch (error) {
    await phone.screenshot({ path: info.outputPath("failure-phone.png") }).catch(() => undefined);
    await writeFile(info.outputPath("diagnostics.json"), JSON.stringify({ snapshots: await Promise.all((await hub.store.conversations("owner")).map((c) => hub.store.snapshot("owner", c.id))), nativeFrames: await readFile(nativeLog, "utf8").catch(() => "") }, null, 2));
    throw error;
  } finally {
    await phoneContext.close(); await page.close(); await hub.close();
    const archivedSessions = await archiveAcceptanceThreads(root);
    await writeFile(info.outputPath("cleanup.json"), JSON.stringify({ archivedSessions, readBackNoVisibleFixtureSessions: true }));
    await rm(root, { recursive: true, force: true });
  }
});
