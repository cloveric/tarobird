import { test, expect, type Page } from "@playwright/test";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HubServer } from "../../src/hub/server.js";
import { hashSecret } from "../../src/hub/auth.js";
import { attachGateway } from "../../src/gateway/service.js";
import type { GatewayChannel } from "../../src/gateway/channel.js";
import { createCoreServiceRuntime } from "../../src/core/runtime.js";
import { preparePairing } from "./fixtures/pairing-invite.js";
import { enterMobileChat, waitForClientOnline } from "./fixtures/mobile.js";
import { microphone } from "./fixtures/microphone.js";

async function pair(page: Page, hub: HubServer) {
  await page.goto(hub.url);
  await preparePairing(page, hub);
  await page.getByRole("button", { name: "配对此设备", exact: true }).click();
  await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
  await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" });
  await waitForClientOnline(page);
}

for (const formFactor of ["desktop", "phone"] as const) {
  test(`${formFactor} shows composer stop during audio transcription without typing/steering and aborts cleanly`, async ({ browser }) => {
    const root = await mkdtemp(path.join(os.tmpdir(), `voice-stop-${formFactor}-`));
    const stateDir = path.join(root, "instance");
    await mkdir(stateDir);
    const engineName = formFactor === "desktop" ? "pi" : "claude";
    await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ engine: engineName, locale: "zh" }));
    const hub = await HubServer.start({ stateDir: path.join(root, "hub"), clientDir: path.resolve("dist") });
    const context = await browser.newContext(
      formFactor === "desktop"
        ? { viewport: { width: 1280, height: 800 } }
        : { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true },
    );
    const page = await context.newPage();
    let gateway: GatewayChannel | undefined;
    try {
      const secret = randomBytes(32).toString("base64url");
      await hub.store.db.run("INSERT INTO bots(id,name,engine,secret_hash) VALUES('alpha','语音测试助手',?,?)", [engineName, hashSecret(secret)]);
      const chat = await hub.store.createConversation("owner", ["alpha"], "语音转写停止", "direct");

      let transcriptionEntered = false;
      let transcriptionAborted = false;
      const engineCalls: string[] = [];
      const runtime = createCoreServiceRuntime({
        transcribeMedia: async (_file, options) => new Promise((_resolve, reject) => {
          transcriptionEntered = true;
          options?.abortSignal?.addEventListener("abort", () => {
            transcriptionAborted = true;
            reject(new Error("transcription aborted by test"));
          }, { once: true });
        }),
      });
      gateway = await attachGateway({
        stateDir,
        url: hub.instanceUrl.replace("http", "ws") + "/instance",
        secret,
        botId: "alpha",
        engine: engineName,
        runtime,
        bridge: {
          supportsSteering: () => true,
          inFlightSendBehavior: () => "steer",
          nativeInputCapability: async () => engineName === "claude" ? { sendNow: true, cancel: true, modelReceipt: true } : undefined,
          steerActiveTurn: async () => false,
          handleAuthorizedMessage: async (input) => {
            engineCalls.push(input.text);
            return { text: `已收到：${input.text}` };
          },
        },
      });

      await pair(page, hub);
      await enterMobileChat(page, chat.title);

      // Send a voice message through the Hub so Gateway runs transcribeMedia.
      const audioBytes = Buffer.from("fixture voice bytes");
      const upload = await hub.attachments.create("owner", {
        conversationId: chat.id,
        name: "voice-1791780593981.webm",
        mime: "audio/webm",
        size: audioBytes.length,
        sha256: createHash("sha256").update(audioBytes).digest("hex"),
      });
      await hub.attachments.putChunk("owner", upload.id, 0, audioBytes);
      await hub.attachments.complete("owner", upload.id);
      await hub.store.sendMessage("owner", {
        conversationId: chat.id,
        clientMsgId: "voice-msg",
        text: "",
        attachments: [upload.id],
      });

      await expect.poll(() => transcriptionEntered).toBe(true);
      await expect(page.locator(".rich-card").first()).toContainText("正在转写音频…");

      // Composer stop button is visible during transcription on both desktop and phone.
      const stopButton = page.locator(".composer-stop.is-live");
      await expect(stopButton).toBeVisible();

      // Must NOT look like a Bot reply: no typing indicator, no "正在回复", no steering choice.
      await expect(page.locator(".message-avatar.bot.is-working")).toHaveCount(0);
      await expect(page.locator(".header-activity:not(:empty)")).toHaveCount(0);
      await expect(page.locator(".claude-send-choice")).toHaveCount(0);
      await expect(page.locator(".composer-steer")).toHaveCount(0);
      if (formFactor === "desktop") {
        await expect(page.locator(".composer-hint")).toContainText("普通发送将排队");
      }

      // Sending a message while transcribing queues it instead of steering or cancelling transcription.
      const draft = page.getByRole("textbox", { name: "消息", exact: true });
      await draft.fill("no transcription");
      await page.getByRole("button", { name: "发送消息", exact: true }).click();
      await expect(draft).toHaveValue("");
      await expect(page.locator(".message-body").getByText("no transcription", { exact: true })).toBeVisible();
      expect(transcriptionAborted).toBe(false);
      expect(engineCalls).toEqual([]);

      // Stop button is visible again (on phone too, now that draft is empty) and aborts transcription.
      await expect(stopButton).toBeVisible();
      await stopButton.click();

      await expect.poll(() => transcriptionAborted).toBe(true);
      await expect(page.locator(".rich-card").first()).toContainText("已停止转写");
      await expect(page.locator(".virtual-messages")).not.toContainText("准备飞书消息时失败");
      await expect(page.locator(".virtual-messages")).not.toContainText("此消息未处理完成");
      await expect(page.locator(".virtual-messages").getByText("已停止。", { exact: true })).toHaveCount(0);
      await expect(stopButton).toHaveCount(0);
      await expect(page.locator(".message-body").getByText("已收到：no transcription", { exact: true })).toBeVisible();
      expect(engineCalls).toEqual(["no transcription"]);
    } finally {
      await context.close();
      await gateway?.disconnect();
      await hub.close();
      await rm(root, { recursive: true, force: true });
    }
  });
}

test("phone HoldToTalk voice mode shows composer stop right after sending a voice clip and aborts transcription", async ({ browser }) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "voice-stop-hold-to-talk-"));
  const stateDir = path.join(root, "instance");
  await mkdir(stateDir);
  await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ engine: "codex", locale: "zh" }));
  const hub = await HubServer.start({ stateDir: path.join(root, "hub"), clientDir: path.resolve("dist") });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  let gateway: GatewayChannel | undefined;
  try {
    const secret = randomBytes(32).toString("base64url");
    await hub.store.db.run("INSERT INTO bots(id,name,engine,secret_hash) VALUES('alpha','语音测试助手','codex',?)", [hashSecret(secret)]);
    const chat = await hub.store.createConversation("owner", ["alpha"], "按住说话转写停止", "direct");

    let transcriptionEntered = false;
    let transcriptionAborted = false;
    const engineCalls: string[] = [];
    const runtime = createCoreServiceRuntime({
      transcribeMedia: async (_file, options) => new Promise((_resolve, reject) => {
        transcriptionEntered = true;
        options?.abortSignal?.addEventListener("abort", () => {
          transcriptionAborted = true;
          reject(new Error("transcription aborted by hold-to-talk test"));
        }, { once: true });
      }),
    });
    gateway = await attachGateway({
      stateDir,
      url: hub.instanceUrl.replace("http", "ws") + "/instance",
      secret,
      botId: "alpha",
      engine: "codex",
      runtime,
      bridge: {
        handleAuthorizedMessage: async (input) => {
          engineCalls.push(input.text);
          return { text: `已收到：${input.text}` };
        },
      },
    });

    await microphone(page);
    await pair(page, hub);
    await enterMobileChat(page, chat.title);

    // Tap the mic shortcut to enter HoldToTalk voice mode, record and send a clip.
    await page.getByRole("button", { name: "录制语音", exact: true }).click();
    const holdButton = page.getByRole("button", { name: "按住说话", exact: true });
    await expect(holdButton).toBeVisible();
    await holdButton.focus();
    await page.keyboard.down("Space");
    await expect(page.getByText("正在录音", { exact: true })).toBeVisible();
    await expect(page.getByLabel("录音时长", { exact: true })).not.toHaveText("00:00");
    await page.keyboard.up("Space");

    await expect.poll(() => transcriptionEntered).toBe(true);
    await expect(page.locator(".rich-card").first()).toContainText("正在转写音频…");

    // Still in HoldToTalk voice mode, the live stop button must be immediately visible beside HoldToTalk.
    await expect(holdButton).toBeVisible();
    const stopButton = page.locator(".hold-voice .composer-stop.is-live");
    await expect(stopButton).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

    // Clicking stop aborts transcription cleanly without leaking errors.
    await stopButton.click();
    await expect.poll(() => transcriptionAborted).toBe(true);
    await expect(page.locator(".rich-card").first()).toContainText("已停止转写");
    await expect(page.locator(".virtual-messages")).not.toContainText("准备飞书消息时失败");
    await expect(page.locator(".virtual-messages").getByText("已停止。", { exact: true })).toHaveCount(0);
    await expect(stopButton).toHaveCount(0);
    expect(engineCalls).toEqual([]);
  } finally {
    await context.close();
    await gateway?.disconnect();
    await hub.close();
    await rm(root, { recursive: true, force: true });
  }
});
