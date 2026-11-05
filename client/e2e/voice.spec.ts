import { preparePairing } from "./fixtures/pairing-invite.js";
import { showDisconnectedBots, waitForClientOnline } from "./fixtures/mobile.js";
import { enterMobileChat, mobileHome } from "./fixtures/mobile.js";
import { microphone } from "./fixtures/microphone.js";
import { test, expect, type Page } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HubServer } from "../../src/hub/server.js";
import { hashSecret } from "../../src/hub/auth.js";
import { attachGateway } from "../../src/gateway/service.js";
import { createCoreServiceRuntime } from "../../src/core/runtime.js";

async function pair(page: Page, hub: HubServer) {
  await page.goto(hub.url); await preparePairing(page, hub); await page.getByRole("button", { name: "配对此设备", exact: true }).click();
  await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
  await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" }); if ((page.viewportSize()?.width ?? 1360) <= 760) { await expect(mobileHome(page)).toBeVisible(); await enterMobileChat(page, "语音与文字"); } else await waitForClientOnline(page);
}
async function select(page: Page, title: string) {
  const menu = page.getByRole("button", { name: "打开会话列表", exact: true }); if (await menu.isVisible()) await menu.click();
  await page.locator(".conversation-row").filter({ has: page.getByText(title, { exact: true }) }).click();
  await expect(page.getByRole("heading", { name: title, exact: true })).toBeVisible();
}
// Synthetic microphone only. The browser's real MediaRecorder, container encoder,
// audio decoder, File/Blob storage, transport and playback are all exercised.
async function allTracksStopped(page: Page) { await expect.poll(() => page.evaluate(() => (window as any).__mic.streams.every((s: MediaStream) => s.getTracks().every((t) => t.readyState === "ended")))).toBe(true); }

test("desktop previews mixed voice/text; phone holds to send voice; both play synchronized audio", async ({ browser }, info) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "voice-browser-")), stateDir = path.join(root, "instance"); await mkdir(stateDir); await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ engine: "codex", locale: "zh" }));
  const hub = await HubServer.start({ stateDir: path.join(root, "hub"), clientDir: path.resolve("dist") }), secret = randomBytes(32).toString("base64url");
  await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','语音助手',?)", [hashSecret(secret)]);
  const captured: Buffer[] = [], inputs: string[] = [];
  const gateway = await attachGateway({ stateDir, url: hub.instanceUrl.replace("http", "ws") + "/instance", botId: "alpha", secret, engine: "codex", runtime: createCoreServiceRuntime({ transcribeMedia: async (file) => { captured.push(await readFile(file)); return "测试录音的转写结果"; } }), bridge: { handleAuthorizedMessage: async (input) => { inputs.push(input.text); return { text: "已结合文字和录音完成处理" }; } } });
  const c = await hub.store.createConversation("owner", ["alpha"], "语音与文字", "voice");
  const dc = await browser.newContext({ viewport: { width: 1360, height: 900 } }), pc = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const desktop = await dc.newPage(), phone = await pc.newPage();
  try {
    for (const page of [desktop, phone]) { await microphone(page); await pair(page, hub); }
    for (const [sender, receiver, device] of [[desktop, phone, "desktop"], [phone, desktop, "phone"]] as const) {
      await sender.bringToFront(); await sender.getByRole("button", { name: "录制语音", exact: true }).click();
      if (device === "phone") {
        await sender.getByRole("button", { name: "按住说话", exact: true }).focus(); await sender.keyboard.down("Space");
      }
      await expect(sender.getByText("正在录音", { exact: true })).toBeVisible();
      if (device === "desktop") await expect(sender.getByRole("button", { name: "发送消息", exact: true })).toBeDisabled();
      await expect(sender.getByLabel("录音时长", { exact: true })).not.toHaveText("00:00");
      await sender.screenshot({ path: info.outputPath(`voice-recording-${device}.png`), fullPage: true });
      const caption = `${device}补充说明：请结合这段录音处理。`;
      if (device === "phone") await sender.keyboard.up("Space");
      else {
        await sender.getByRole("button", { name: "完成录音", exact: true }).click();
        const preview = sender.getByRole("region", { name: "待发送的附件", exact: true }); await expect(preview.locator("audio")).toHaveCount(1);
        await expect.poll(() => preview.locator("audio").evaluate((audio: HTMLAudioElement) => audio.readyState >= 1 && audio.duration > 0 && !audio.error)).toBe(true);
        await sender.getByRole("textbox", { name: "消息", exact: true }).fill(caption);
        await sender.screenshot({ path: info.outputPath(`voice-preview-${device}.png`), fullPage: true });
        await sender.getByRole("button", { name: "发送消息", exact: true }).click();
        await expect(receiver.locator(".message-blocks").getByText(caption, { exact: true })).toBeVisible();
      }
      await allTracksStopped(sender); expect(await sender.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await expect.poll(() => inputs.length).toBe(device === "desktop" ? 1 : 2);
      if (device === "desktop") expect(inputs.at(-1)).toContain(caption);
      expect(inputs.at(-1)).toContain("Bridge media transcription completed"); expect(inputs.at(-1)).toContain("测试录音的转写结果");
      const messages = (await hub.store.snapshot("owner", c.id)).messages.filter((m) => m.authorType === "user"); expect(messages).toHaveLength(device === "desktop" ? 1 : 2);
      const message = messages.at(-1)!; expect(message.blocks.map((b) => b.type)).toEqual(device === "desktop" ? ["text", "audio"] : ["audio"]); const block = message.blocks.find(b => b.type === "audio")!; if (block.type !== "audio") throw new Error("missing audio");
      const attachment = await hub.attachments.download({ userId: "owner" }, block.attachmentId), bytes = await readFile(attachment.path); expect(bytes.length).toBeGreaterThan(1000); expect(bytes).toEqual(captured.at(-1)); expect(attachment.row.mime).toMatch(/^audio\/(mp4|webm|ogg)/);
      // Preserve the native encoded recording as an acceptance artifact.
      await writeFile(info.outputPath(`${device}-${attachment.row.name}`), bytes);
      const audio = receiver.locator(`[data-message-id="${message.id}"] audio`); await expect(audio).toBeVisible();
      expect((await audio.boundingBox())!.width).toBeGreaterThan(200);
      await expect.poll(() => audio.evaluate((el: HTMLAudioElement) => el.readyState >= 1 && el.duration > 0 && !el.error)).toBe(true);
      await receiver.bringToFront(); await audio.evaluate(async (el: HTMLAudioElement) => { await el.play(); });
      await expect.poll(() => audio.evaluate((el: HTMLAudioElement) => el.currentTime)).toBeGreaterThan(0); await audio.evaluate((el: HTMLAudioElement) => el.pause());
    }
  } finally { await dc.close(); await pc.close(); await gateway.disconnect(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});

test("cancel, denied or pending permission and conversation changes never leave a microphone or a stray voice draft", async ({ page }) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "voice-lifecycle-")), hub = await HubServer.start({ stateDir: root, clientDir: path.resolve("dist") });
  try {
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','语音助手','fixture')");
    const one = await hub.store.createConversation("owner", ["alpha"], "第一段对话", "one"), two = await hub.store.createConversation("owner", ["alpha"], "第二段对话", "two");
    await microphone(page); await pair(page, hub); await showDisconnectedBots(page); await select(page, "第一段对话"); const mic = page.getByRole("button", { name: "录制语音", exact: true });
    await page.evaluate(() => { (window as any).__mic.mode = "deny"; }); await mic.click(); await expect(page.getByRole("alert")).toContainText("允许麦克风"); await expect(mic).toBeEnabled();
    await page.evaluate(() => { (window as any).__mic.mode = "pending"; }); await mic.click(); await expect(page.getByText("等待麦克风权限…", { exact: true })).toBeVisible(); await expect(mic).toBeDisabled();
    expect(await page.evaluate(() => !window.dispatchEvent(new Event("tarocub-native-back", { cancelable: true })))).toBe(true); await page.evaluate(() => (window as any).__mic.resolve());
    await expect.poll(() => page.evaluate(() => (window as any).__mic.streams.length)).toBe(1); await allTracksStopped(page); await expect(page.locator(".audio-draft")).toHaveCount(0);
    await page.evaluate(() => { (window as any).__mic.mode = "ok"; }); await mic.click(); await expect(page.getByText("正在录音", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "取消录音", exact: true }).click(); await allTracksStopped(page); await expect(page.locator(".audio-draft")).toHaveCount(0);
    await mic.click(); await expect(page.getByText("正在录音", { exact: true })).toBeVisible(); await select(page, "第二段对话"); await allTracksStopped(page); await expect(page.locator(".audio-draft")).toHaveCount(0); await expect(mic).toBeEnabled();
    await page.evaluate(() => { (window as any).__mic.mode = "pending"; }); await mic.click(); await expect(page.getByText("等待麦克风权限…", { exact: true })).toBeVisible(); await select(page, "第一段对话");
    await page.evaluate(() => (window as any).__mic.resolve()); await expect.poll(() => page.evaluate(() => (window as any).__mic.streams.length)).toBe(4); await allTracksStopped(page); await expect(page.locator(".audio-draft")).toHaveCount(0);
    await page.evaluate(() => { (window as any).__mic.mode = "ok"; }); await mic.click(); await expect(page.getByText("正在录音", { exact: true })).toBeVisible();
    await page.evaluate(() => (window as any).__mic.recorder.dispatchEvent(new Event("error"))); await allTracksStopped(page); await expect(page.getByRole("alert")).toContainText("录音中断"); await expect(page.locator(".audio-draft")).toHaveCount(0);
    await mic.click(); await expect(page.getByLabel("录音时长", { exact: true })).not.toHaveText("00:00");
    await page.evaluate(() => { Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" }); document.dispatchEvent(new Event("visibilitychange")); });
    await allTracksStopped(page); await expect(page.locator(".audio-draft audio")).toHaveCount(1);
    await page.evaluate(() => { delete (document as any).visibilityState; });
    for (const c of [one, two]) expect((await hub.store.snapshot("owner", c.id)).messages).toHaveLength(0);
  } finally { await page.close(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});
