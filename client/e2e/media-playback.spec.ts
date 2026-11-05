import { preparePairing } from "./fixtures/pairing-invite.js";
import { expect, test, type Locator } from "@playwright/test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HubServer } from "../../src/hub/server.js";
import { showDisconnectedBots, selectConversation, waitForClientOnline } from "./fixtures/mobile.js";

const formats = [
  { name: "tone.wav", mime: "audio/wav" },
  { name: "tone.mp3", mime: "audio/mpeg" },
  { name: "tone.m4a", mime: "audio/mp4" },
  { name: "clip.mp4", mime: "video/mp4" },
  { name: "clip-720p.mp4", mime: "video/mp4", dimensions: [1280, 720] },
  { name: "历史视频_720p.MP4", mime: "application/octet-stream", fixture: "clip.mp4" },
  { name: "历史录音.m4a", mime: "application/octet-stream", fixture: "tone.m4a" },
];
async function playAndSeek(media: Locator) {
  await expect.poll(() => media.evaluate((node: HTMLMediaElement) => Number.isFinite(node.duration) && node.duration > 2 && !node.error)).toBe(true);
  await media.evaluate(async (node: HTMLMediaElement) => { node.muted = true; await node.play(); });
  await expect.poll(() => media.evaluate((node: HTMLMediaElement) => node.currentTime)).toBeGreaterThan(.2);
  await media.evaluate((node: HTMLMediaElement) => { node.pause(); node.currentTime = 1.5; });
  await expect.poll(() => media.evaluate((node: HTMLMediaElement) => !node.seeking && Math.abs(node.currentTime - 1.5) < .15)).toBe(true);
  await media.evaluate(async (node: HTMLMediaElement) => { await node.play(); });
  await expect.poll(() => media.evaluate((node: HTMLMediaElement) => node.currentTime)).toBeGreaterThan(1.7);
  return media.evaluate((node: HTMLVideoElement) => ({ duration: node.duration, currentTime: node.currentTime, error: node.error?.code ?? null, videoWidth: node.videoWidth || 0, videoHeight: node.videoHeight || 0 }));
}

// Keep each media family independent so eleven play/seek cycles do not share
// one 60-second deadline and hide file-center download checks after a timeout.
const playbackScenarios = [
  { kind: "audio", name: "audio previews really play, seek and stop on close" },
  { kind: "video", name: "video previews really play, seek and stop on close" },
  { kind: "inline", name: "inline audio attachments really play and seek" },
  { kind: "files", name: "file center video plays, seeks and saves its original bytes" },
] as const;
for (const width of [1360, 390]) for (const scenario of playbackScenarios) test(`${scenario.name} (${width}px)`, async ({ browser }, info) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "media-playback-"));
  const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve("dist") });
  const context = await browser.newContext({ viewport: { width, height: 844 } }), page = await context.newPage();
  try {
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('media','播放助手','fixture')");
    const chat = await hub.store.createConversation("owner", ["media"], "音视频播放", "media-playback");
    const audioIds: string[] = [];
    for (const { name, mime, fixture } of formats) {
      const bytes = await readFile(`e2e/fixtures/media/${fixture ?? name}`);
      const attachmentId = await hub.attachments.importForBot("media", { conversationId: chat.id, name, mime, size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") }, bytes);
      await hub.store.publishBotMessage("media", { conversationId: chat.id, blocks: [{ type: "file", attachmentId, name, mime, size: bytes.length }] });
      if (mime.startsWith("audio/")) audioIds.push(attachmentId);
    }
    await page.goto(hub.url); await preparePairing(page, hub); await page.getByRole("button", { name: "配对此设备", exact: true }).click();
    await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
    await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" }); await showDisconnectedBots(page);
    await waitForClientOnline(page); await selectConversation(page, chat.title);
    const previews = formats.filter(({ name, mime }) => {
      const audio = mime.startsWith("audio/") || name.endsWith(".m4a");
      return scenario.kind === "audio" ? audio : scenario.kind === "video" ? !audio : false;
    });
    for (const { name, mime, dimensions = [160, 90] } of previews) {
      await page.getByRole("region", { name, exact: true }).getByRole("button", { name: /^预览(?: |$)/ }).click();
      const dialog = page.getByRole("dialog", { name: "文件预览", exact: true });
      const isAudio = mime.startsWith("audio/") || name.endsWith(".m4a");
      const media = dialog.locator(isAudio ? "audio[controls]" : "video[controls]");
      await expect(media).toBeVisible();
      if (!isAudio) {
        // An explicit frame cover prevents Android WebView's enlarged default
        // play graphic beneath its actual playback controls.
        await expect(media).toHaveAttribute("poster", /^data:image\/jpeg;base64,/);
        const cover = await media.evaluate(async (node: HTMLVideoElement) => {
          const image = new Image(); image.src = node.poster; await image.decode();
          const canvas = document.createElement("canvas"); canvas.width = image.width; canvas.height = image.height;
          const ctx = canvas.getContext("2d")!; ctx.drawImage(image, 0, 0);
          const colors = new Set<number>(), data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
          for (let i = 0; i < data.length; i += 4) colors.add((data[i]! << 16) | (data[i + 1]! << 8) | data[i + 2]!);
          return { colors: colors.size, width: image.width, height: image.height, paused: node.paused, time: node.currentTime };
        });
        const scale = Math.min(1, 640 / Math.max(...dimensions));
        expect(cover).toMatchObject({ width: Math.round(dimensions[0]! * scale), height: Math.round(dimensions[1]! * scale), paused: true, time: 0 });
        expect(cover.colors).toBeGreaterThan(100);
        await dialog.screenshot({ path: info.outputPath(`video-before-play-${width}-${name}.png`) });
      }
      const beforePlaying = await media.boundingBox();
      const result = await playAndSeek(media);
      if (!isAudio) {
        expect([result.videoWidth, result.videoHeight]).toEqual(dimensions);
        const afterPlaying = (await media.boundingBox())!;
        expect(afterPlaying.width).toBeCloseTo(beforePlaying!.width, 0);
        expect(afterPlaying.height).toBeCloseTo(beforePlaying!.height, 0);
      }
      await info.attach(name, { contentType: "application/json", body: JSON.stringify(result) });
      await media.evaluate(node => { (window as any).__closingMedia = node; });
      await dialog.getByRole("button", { name: "关闭", exact: true }).click();
      await expect(dialog).toHaveCount(0);
      await expect.poll(() => page.evaluate(() => (window as any).__closingMedia.paused)).toBe(true);
    }
    if (scenario.kind === "inline") for (const attachmentId of audioIds) {
      const message = await hub.store.publishBotMessage("media", { conversationId: chat.id, blocks: [{ type: "audio", attachmentId }] });
      const media = page.locator(`[data-message-id="${message.id}"] audio`);
      await expect(page.locator(`[data-message-id="${message.id}"] .attachment-audio`)).toBeVisible(); await playAndSeek(media); await media.evaluate((node: HTMLMediaElement) => node.pause());
    }
    if (scenario.kind === "files") {
      await page.getByRole("button", { name: "更多聊天操作", exact: true }).click();
      await page.getByRole("button", { name: "文件", exact: true }).click();
      const files = page.getByRole("dialog", { name: "对话文件", exact: true });
      await files.getByRole("button", { name: "预览 历史视频_720p.MP4", exact: true }).click();
      const preview = page.getByRole("dialog", { name: "文件预览", exact: true });
      await playAndSeek(preview.locator("video"));
      const download = page.waitForEvent("download"); await preview.getByRole("button", { name: "另存为", exact: true }).click();
      expect(await readFile((await (await download).path())!)).toEqual(await readFile("e2e/fixtures/media/clip.mp4"));
      await preview.getByRole("button", { name: "关闭", exact: true }).click();
      await expect(files).toBeVisible();
    }
  } finally { await context.close(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});

for (const [width, height] of [[390, 844], [1360, 844], [1360, 520]]) test(`video preview box keeps the video's aspect ratio (${width}x${height})`, async ({ browser }, info) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "video-geometry-"));
  const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve("dist") });
  const context = await browser.newContext({ viewport: { width, height } }), page = await context.newPage();
  try {
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('media','播放助手','fixture')");
    const chat = await hub.store.createConversation("owner", ["media"], "视频比例", "video-geometry");
    const bytes = await readFile("e2e/fixtures/media/clip-720p.mp4"), name = "clip-720p.mp4";
    const attachmentId = await hub.attachments.importForBot("media", { conversationId: chat.id, name, mime: "video/mp4", size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") }, bytes);
    await hub.store.publishBotMessage("media", { conversationId: chat.id, blocks: [{ type: "file", attachmentId, name, mime: "video/mp4", size: bytes.length }] });
    await page.goto(hub.url); await preparePairing(page, hub); await page.getByRole("button", { name: "配对此设备", exact: true }).click();
    await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
    await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" }); await showDisconnectedBots(page);
    await waitForClientOnline(page); await selectConversation(page, chat.title);
    await page.getByRole("region", { name, exact: true }).getByRole("button", { name: /^预览(?: |$)/ }).click();
    const dialog = page.getByRole("dialog", { name: "文件预览", exact: true }), media = dialog.locator("video[controls]");
    await expect(media).toHaveAttribute("poster", /^data:image\/jpeg;base64,/, { timeout: 20_000 });
    await expect.poll(() => media.evaluate((node: HTMLVideoElement) => node.readyState)).toBeGreaterThanOrEqual(1);
    const box = (await media.boundingBox())!;
    await dialog.screenshot({ path: info.outputPath(`video-geometry-${width}x${height}.png`) });
    await info.attach("box", { contentType: "application/json", body: JSON.stringify(box) });
    // Native controls sit on the element's bottom edge; a box taller than the
    // picture leaves them detached below a letterboxed frame.
    expect(box.width / box.height).toBeCloseTo(1280 / 720, 1);
  } finally { await context.close(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});

for (const layout of ["desktop", "phone", "adhd"] as const) test(`inline audio remains playing outside the virtual viewport and releases on pause (${layout})`, async ({ page }) => {
  if (layout === "phone") await page.setViewportSize({ width: 390, height: 844 });
  const root = await mkdtemp(path.join(os.tmpdir(), "inline-audio-retention-"));
  const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve("dist") });
  try {
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('media','播放助手','fixture')");
    const chat = await hub.store.createConversation("owner", ["media"], "行内音频保留", "inline-audio-retention");
    for (let i = 0; i < 70; i++) await hub.store.publishBotMessage("media", { conversationId: chat.id, blocks: [{ type: "text", text: `历史记录 ${i}\n`.repeat(4) }] });
    const bytes = await readFile("e2e/fixtures/media/tone.wav");
    const attachmentId = await hub.attachments.importForBot("media", { conversationId: chat.id, name: "tone.wav", mime: "audio/wav", size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") }, bytes);
    const message = await hub.store.publishBotMessage("media", { conversationId: chat.id, blocks: [{ type: "audio", attachmentId }] });
    await page.goto(hub.url); await preparePairing(page, hub); await page.getByRole("button", { name: "配对此设备", exact: true }).click();
    await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
    await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" }); await showDisconnectedBots(page);
    await waitForClientOnline(page); await selectConversation(page, chat.title);
    if (layout === "adhd") {
      await page.getByRole("button", { name: "打开 ADHD 模式", exact: true }).click();
      await page.getByRole("checkbox", { name: /加入面板：.*行内音频保留$/ }).check();
    }
    const scope = layout === "adhd" ? page.locator(".adhd-card").first() : page.locator(".host-workspace:not([hidden])");
    const media = scope.locator(`[data-message-id="${message.id}"] audio`);
    await expect(scope.locator(`[data-message-id="${message.id}"] .attachment-audio`)).toBeVisible();
    await media.evaluate(async (node: HTMLMediaElement) => { node.muted = true; node.loop = true; node.dataset.original = "yes"; await node.play(); });
    await expect.poll(() => media.evaluate((node: HTMLMediaElement) => node.currentTime)).toBeGreaterThan(.1);
    await scope.locator(".message-scroll").evaluate(node => { node.dispatchEvent(new WheelEvent("wheel", { deltaY: -500, bubbles: true })); node.scrollTop = 0; });
    await expect.poll(() => scope.locator(".message-scroll").evaluate(node => node.scrollTop)).toBeLessThan(100);
    await expect(media).toBeAttached(); await expect(media).toHaveAttribute("data-original", "yes");
    expect(await media.evaluate((node: HTMLMediaElement) => node.paused)).toBe(false);
    await media.evaluate((node: HTMLMediaElement) => node.pause());
    await expect(media).toHaveCount(0);
  } finally { await page.close(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});

test("undecodable inline audio offers its unchanged original for saving", async ({ page }) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "inline-audio-decode-"));
  const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve("dist") });
  try {
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('media','播放助手','fixture')");
    const chat = await hub.store.createConversation("owner", ["media"], "音频解码反馈", "inline-audio-decode");
    const bytes = Buffer.from("synthetic invalid wav bytes");
    const attachmentId = await hub.attachments.importForBot("media", { conversationId: chat.id, name: "broken.wav", mime: "audio/wav", size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") }, bytes);
    const message = await hub.store.publishBotMessage("media", { conversationId: chat.id, blocks: [{ type: "audio", attachmentId }] });
    await page.goto(hub.url); await preparePairing(page, hub); await page.getByRole("button", { name: "配对此设备", exact: true }).click();
    await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
    await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" }); await showDisconnectedBots(page);
    await waitForClientOnline(page); await selectConversation(page, chat.title);
    const row = page.locator(`[data-message-id="${message.id}"] .attachment-audio`);
    await expect(row.getByRole("alert")).toContainText("此设备无法预览该文件");
    const download = page.waitForEvent("download");
    await row.getByRole("button", { name: "另存为", exact: true }).click();
    expect(await readFile((await (await download).path())!)).toEqual(bytes);
  } finally { await page.close(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});

test("opt-in existing generic MP4 plays its unchanged bytes", async ({ page }, info) => {
  const file = process.env.TAROBOT_PREVIEW_ACCEPTANCE_FILE;
  test.skip(!file, "Set a local MP4 path to verify a reported attachment without changing live state.");
  const root = await mkdtemp(path.join(os.tmpdir(), "media-reported-file-"));
  const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve("dist") });
  try {
    const bytes = await readFile(file!), name = "existing-video.mp4", mime = "application/octet-stream";
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('media','播放助手','fixture')");
    const chat = await hub.store.createConversation("owner", ["media"], "视频预览验收", "reported-file");
    const attachmentId = await hub.attachments.importForBot("media", { conversationId: chat.id, name, mime, size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") }, bytes);
    await hub.store.publishBotMessage("media", { conversationId: chat.id, blocks: [{ type: "file", attachmentId, name, mime, size: bytes.length }] });
    await page.goto(hub.url); await preparePairing(page, hub); await page.getByRole("button", { name: "配对此设备", exact: true }).click();
    await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
    await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" }); await showDisconnectedBots(page);
    await waitForClientOnline(page); await selectConversation(page, chat.title);
    await page.getByRole("button", { name: `预览 ${name}`, exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "文件预览", exact: true });
    const result = await playAndSeek(dialog.locator("video"));
    expect(result.videoWidth).toBeGreaterThan(0);
    await dialog.locator("video").evaluate((node: HTMLVideoElement) => node.pause());
    await info.attach("reported-video", { contentType: "application/json", body: JSON.stringify({ ...result, sha256: createHash("sha256").update(bytes).digest("hex"), size: bytes.length }) });
    await page.screenshot({ path: info.outputPath("reported-video-preview.png") });
  } finally { await page.close(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});
