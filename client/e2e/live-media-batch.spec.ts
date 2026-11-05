import { preparePairing } from "./fixtures/pairing-invite.js";
import { clickAppAction } from "./fixtures/desktop-actions.js";
import { selectConversation, waitForClientOnline } from "./fixtures/mobile.js";
import { test, expect, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { HubServer } from "../../src/hub/server.js";
import { blocksText, type CardElement } from "../../src/client-protocol/index.js";
import { mediaBatchFixture } from "./fixtures/media-batch.js";

const hash = (value: Buffer) => createHash("sha256").update(value).digest("hex");
const definitions = {
  claude: { executable: process.env.CLAUDE_EXECUTABLE || "claude", model: "sonnet", envKey: "CLAUDE_EXECUTABLE" },
  kimi: { executable: process.env.KIMI_EXECUTABLE || path.join(os.homedir(), ".kimi-code/bin/kimi"), model: "", envKey: "KIMI_EXECUTABLE" },
  antigravity: { executable: process.env.ANTIGRAVITY_EXECUTABLE || "agy", model: "", envKey: "ANTIGRAVITY_EXECUTABLE" },
} as const;
const choice = process.env.TAROCUB_LIVE_MEDIA_ENGINE ?? "claude";
if (!Object.hasOwn(definitions, choice)) throw new Error("Unknown TAROCUB_LIVE_MEDIA_ENGINE");
const engine = choice as keyof typeof definitions;
const definition = definitions[engine];
type InputFrame = { type?: string; files?: string[]; observerPid?: number; childPid?: number };
const answerText = (blocks: Parameters<typeof blocksText>[0]) => blocks.flatMap((block) => block.type === "text" ? [block.text]
  : block.type === "card" ? block.elements.flatMap((element) => element.type === "markdown" ? [element.text] : []) : []).join("\n");
test.use({ actionTimeout: 15_000 });
test(`real ${engine} receives ten images and a PDF, reads every code and returns one titled image grid`, async ({ page, browser }, info) => {
  test.skip(process.env.TAROCUB_LIVE_MEDIA_BATCH !== "1", "requires explicit authenticated real-model acceptance");
  test.setTimeout(300_000);
  const { executable, model } = definition;
  const cli = execFileSync(executable, ["--version"], { encoding: "utf8" }).trim();
  const fixture = await mediaBatchFixture();
  const root = await mkdtemp(path.join(os.tmpdir(), "live-media-batch-"));
  const workspace = path.join(root, "workspace"); await mkdir(workspace);
  const inputLog = path.join(root, "input-files.jsonl"), wrapper = path.join(root, "media-observer.cjs");
  await writeFile(wrapper, `#!${process.execPath}
const { spawn } = require('node:child_process');
const { appendFileSync } = require('node:fs');
const { StringDecoder } = require('node:string_decoder');
const child = spawn(${JSON.stringify(executable)}, [...process.argv.slice(2), ...${JSON.stringify(engine === 'claude' ? ['--no-session-persistence'] : [])}], { stdio: ['pipe', 'inherit', 'inherit'], env: process.env });
appendFileSync(${JSON.stringify(inputLog)}, JSON.stringify({ type: 'launch', observerPid: process.pid, childPid: child.pid }) + '\\n');
const decoder = new StringDecoder('utf8'); let pending = '';
process.stdin.on('data', (chunk) => {
  child.stdin.write(chunk); pending += decoder.write(chunk);
  const lines = pending.split('\\n'); pending = lines.pop();
  for (const line of lines) { try {
    const frame = JSON.parse(line);
    if (frame.type !== 'user' && frame.event !== 'user' && frame.method !== 'session/prompt') continue;
    const content = frame.method === 'session/prompt' ? frame.params?.prompt : frame.message?.content;
    const text = typeof content === 'string' ? content : Array.isArray(content) ? content.filter((part) => part.type === 'text').map((part) => part.text).join('\\n') : '';
    const files = [...text.matchAll(/^Attachment: (.+)$/gm)].map((match) => match[1]);
    appendFileSync(${JSON.stringify(inputLog)}, JSON.stringify({ type: 'input', files }) + '\\n');
  } catch {} }
});
process.stdin.on('end', () => child.stdin.end()); child.stdin.on('error', () => {});
for (const signal of ['SIGTERM','SIGINT']) process.on(signal, () => child.kill(signal));
child.on('error', () => process.exit(1)); child.on('exit', (code) => process.exit(code ?? 1));
`);
  await chmod(wrapper, 0o700);
  const env = { ...process.env, [definition.envKey]: wrapper };
  if (engine === "kimi") {
    // Keep fixture sessions out of the user's native inbox. Only existing
    // configuration/credentials are shared; no credential value is logged.
    const home = path.join(root, "kimi-home"), nativeHome = process.env.KIMI_CODE_HOME ?? path.join(os.homedir(), ".kimi-code");
    await mkdir(path.join(home, "workspace-trust"), { recursive: true, mode: 0o700 });
    await symlink(path.join(nativeHome, "config.toml"), path.join(home, "config.toml"));
    await symlink(path.join(nativeHome, "credentials"), path.join(home, "credentials"), "dir");
    const trustKey = `wd_workspace_${createHash("sha256").update(workspace).digest("hex").slice(0, 12)}`;
    await writeFile(path.join(home, "workspace-trust", trustKey), JSON.stringify({ root: workspace, trustedAt: Date.now() }), { mode: 0o600, flag: "wx" });
    env.KIMI_CODE_HOME = home;
  }
  const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve("dist"), managedBots: { entrypoint: path.resolve("../dist/src/index.js"), env } });
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
    await page.getByLabel("Bot 名称", { exact: true }).fill("图片与 PDF 验收");
    await page.getByLabel("引擎", { exact: true }).selectOption(engine);
    await page.getByLabel("模型", { exact: true }).selectOption(model);
    await page.getByLabel("推理强度（effort）").selectOption("low");
    await page.getByText("高级设置", { exact: true }).click(); await page.getByLabel("工作区（可选）", { exact: true }).fill(workspace);
    await page.getByRole("button", { name: "创建 Bot", exact: true }).click();
    await expect(page.getByText("Bot 已上线，可以开始对话。", { exact: true })).toBeVisible({ timeout: 15_000 });
    await page.getByRole("button", { name: "开始对话", exact: true }).click(); await pair(phone);
    const bot = (await hub.store.bots("owner"))[0]!, conversation = (await hub.store.conversations("owner"))[0]!;
    await selectConversation(phone, conversation.title);
    const prompt ='本次测试一起发送了 10 张 PNG 和 1 个 PDF。请实际读取全部附件：每张图内有 IMAGE 序号及一个八位编号，PDF 内有 PDF_CODE。把读取结果写入工作区 receipt.json，JSON 格式为 {"images":[{"number":1,"code":"图内编号"},…],"pdfCode":"PDF内编号"}。不要猜编号，不要修改原附件，不发送到外部平台。然后使用当前 App 的 send.batch 将收到的十张 PNG 原样回传为一组带标题图集，各图标题依次为「验收图 01」至「验收图 10」，同时回传原 PDF（说明「批次原始文档」）和 receipt.json（说明「批次读取结果」）。完成后回复 MEDIA_BATCH_OK。';
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
    await expect.poll(async () => (await hub.store.snapshot("owner", conversation.id)).messages.some((m) => m.authorType === "bot" && m.status === "complete" && answerText(m.blocks).includes("MEDIA_BATCH_OK")), { timeout: 180_000 }).toBe(true);
    await expect.poll(async () => (await hub.store.pendingForBot(bot.id)).length).toBe(0);
    const frames: InputFrame[] = (await readFile(inputLog, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    const first = z.object({ files: z.array(z.string()) }).parse(frames.find((frame) => frame.type === "input" && frame.files?.length)); expect(first.files).toHaveLength(11);
    const inputHashes = await Promise.all(first.files.map(async (file) => hash(await readFile(file))));
    expect(inputHashes.sort()).toEqual(attachments.map((file) => hash(file.buffer)).sort());
    const messages = (await hub.store.snapshot("owner", conversation.id)).messages.filter((m) => m.authorType === "bot");
    const reports = messages.flatMap((m) => m.blocks.filter((b) => b.type === "file" && b.name === "receipt.json"));
    expect(reports).toHaveLength(1);
    const reportFile = reports[0]!;
    if (reportFile.type !== "file") throw new Error("Expected the delivered report file");
    const reportAttachment = await hub.attachments.download({ userId: "owner" }, reportFile.attachmentId);
    const reportSchema = z.object({ images: z.array(z.object({ number: z.number().int(), code: z.string() })).length(10), pdfCode: z.string() });
    const report = reportSchema.parse(JSON.parse(await readFile(reportAttachment.path, "utf8")));
    // Keep model recognition failures as test failures while still checking
    // the delivery bytes; otherwise a misread code hides transport evidence.
    const expectedImages = fixture.images.map(({ number, code }) => ({ number, code }));
    report.images.sort((a, b) => a.number - b.number);
    const readEveryImageCode = JSON.stringify(report.images) === JSON.stringify(expectedImages);
    const readPdfCode = report.pdfCode === fixture.pdfCode;
    expect.soft(report.images, "actual image-code recognition").toEqual(expectedImages);
    expect.soft(report.pdfCode, "actual PDF-code recognition").toBe(fixture.pdfCode);
    const walk = (elements: CardElement[]): CardElement[] => elements.flatMap((element) => [element, ...walk(element.children ?? [])]);
    const galleries = messages.flatMap((m) => m.blocks.flatMap((block) => block.type === "card" && walk(block.elements).filter((e) => e.type === "image").length ? [{ messageId: m.id, elements: walk(block.elements) }] : []));
    expect(galleries).toHaveLength(1);
    const galleryImages = galleries[0]!.elements.filter((e) => e.type === "image"); expect(galleryImages).toHaveLength(10);
    for (const [i, image] of galleryImages.entries()) {
      const file = await hub.attachments.download({ userId: "owner" }, image.attachmentId!);
      expect(hash(await readFile(file.path))).toBe(hash(fixture.images[i]!.buffer));
    }
    const returnedFiles = messages.flatMap((m) => m.blocks.flatMap((block) => block.type === "file" ? [{ messageId: m.id, block, text: blocksText(m.blocks) }] : []));
    expect(returnedFiles).toHaveLength(2);
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
    await writeFile(info.outputPath("live-media-batch.json"), JSON.stringify({ testedAt: new Date().toISOString(), engine, cli, model: model || "engine-default", effort: "low", phoneComposerInputCount: 11, atomicUserMessages: 1, nativeCliInputFiles: first.files.length, nativeCliInputHashesMatch: true, readEveryImageCode, readPdfCode, expectedImageCodes: expectedImages, reportedImageCodes: report.images, returnedImageGrids: 1, titledImages: 10, unchangedOriginalImages: true, unchangedOriginalPdf: true, reportFileParsed: true, pairedBrowserContexts: 2, physicalDevices: false, receivedHashes, cliSessionPersistence: engine === "antigravity", isolatedKimiHome: engine === "kimi", deliveryProtocol: engine === "claude" ? "App gallery delivery; native versus compatibility not asserted" : "send.batch compatibility directive", productionBehaviorModified: false }, null, 2));
  } catch (error) {
    await phone.screenshot({ path: info.outputPath("failure-phone.png") }).catch(() => undefined);
    await writeFile(info.outputPath("diagnostics.json"), JSON.stringify({ snapshots: await Promise.all((await hub.store.conversations("owner")).map((c) => hub.store.snapshot("owner", c.id))), inputFiles: await readFile(inputLog, "utf8").catch(() => "") }, null, 2));
    throw error;
  } finally {
    const browserCleanup = await Promise.allSettled([phoneContext.close(), page.close()]);
    await hub.close();
    const frames: InputFrame[] = (await readFile(inputLog, "utf8").catch(() => "")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
    const launches = frames.filter((frame) => frame.type === "launch");
    await expect.poll(() => launches.every((entry) => [entry.observerPid, entry.childPid].every((pid) => {
      if (!Number.isInteger(pid) || !pid || pid <= 1) return false;
      try { process.kill(pid, 0); return false; } catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
    })), { timeout: 15_000 }).toBe(true);
    await rm(root, { recursive: true, force: true });
    await writeFile(info.outputPath("cleanup.json"), JSON.stringify({ observerAndNativeChildrenStopped: true, launches: launches.length, ownedFixtureRemoved: true, isolatedKimiHome: engine === "kimi", nativeHistoryRetained: engine === "antigravity" }, null, 2));
    const failures = browserCleanup.filter((result) => result.status === "rejected");
    if (failures.length) throw new AggregateError(failures.map((result) => result.reason), "Media acceptance browser cleanup failed");
  }
});
