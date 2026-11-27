import { preparePairing } from "./fixtures/pairing-invite.js";
import { selectConversation } from "./fixtures/mobile.js";
import { test, expect, type Page } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HubServer } from "../../src/hub/server.js";
import { hashSecret } from "../../src/hub/auth.js";
import { attachGateway } from "../../src/gateway/service.js";
import { createCoreServiceRuntime } from "../../src/core/runtime.js";

type TimingRecord = {
  id: number;
  conversationId: string;
  clientMsgId?: string;
  messageId?: string;
  kind: "direct" | "group" | "side";
  route?: string;
  messageLength: number;
  enterAt: number;
  enqueueDoneAt?: number;
  historyReadDoneAt?: number;
  bubbleVisibleAt?: number;
  composerClearedAt?: number;
  error?: string;
};

async function pair(page: Page, hub: HubServer) {
  await page.addInitScript(() => localStorage.setItem("tarobird.debug.sendTiming", "1"));
  await page.goto(hub.url);
  await preparePairing(page, hub);
  await page.getByRole("button", { name: "配对此设备", exact: true }).click();
  await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
  await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" });
}

test("send timing probe tracks scrolled-up virtualizer reveal, side attachment/repeat isolation, and Ctrl+Enter guards", async ({ page }) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "send-timing-e2e-"));
  const stateDir = path.join(root, "bot");
  await mkdir(stateDir);
  await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ engine: "claude", locale: "zh" }));
  const hub = await HubServer.start({ stateDir: path.join(root, "hub"), clientDir: path.resolve("dist") });
  const secret = randomBytes(32).toString("base64url");
  await hub.store.db.run("INSERT INTO bots(id,name,secret_hash,engine) VALUES('alpha','Claude',?,'claude')", [hashSecret(secret)]);
  const chat = await hub.store.createConversation("owner", ["alpha"], "Timing E2E", "timing_main");
  for (let i = 0; i < 45; i++) {
    await hub.store.publishBotMessage("alpha", {
      conversationId: chat.id,
      blocks: [{ type: "text", text: `Seed message #${i}\nLine 2 of seed message #${i}\nLine 3 of seed message #${i}` }],
    });
  }
  let sideCalls = 0;
  const gateway = await attachGateway({
    stateDir,
    url: hub.instanceUrl.replace("http", "ws") + "/instance",
    botId: "alpha",
    secret,
    engine: "claude",
    runtime: createCoreServiceRuntime(),
    bridge: {
      handleAuthorizedMessage: async ({ text }) => ({ text: `Echo: ${text}` }),
      sideCapability: () => ({ context: "native", concurrent: true, readOnly: "enforced", residue: "none", seesInProgressTurn: false, attachments: { images: true, files: "any", paths: true } }),
      openSideSession: async () => ({
        nativeId: "side_native_1",
        dispose: async () => undefined,
        send: async ({ text, attachments }) => {
          sideCalls++;
          if (sideCalls === 2) {
            await new Promise(resolve => setTimeout(resolve, 150));
          }
          return { text: attachments?.length ? `Side file reply (${attachments.length})` : `Side reply #${sideCalls}: ${text}` };
        },
      }),
    },
  });

  try {
    await page.setViewportSize({ width: 1360, height: 844 });
    await pair(page, hub);
    await selectConversation(page, "Timing E2E");
    await expect(page.locator(".message-scroll .message").filter({ hasText: "Seed message #44" })).toBeVisible();

    // 1. Pre-guard Ctrl+Enter with empty draft when Workbench is open must not append phantom unretired records.
    await page.evaluate(() => (window as unknown as { __tarobirdSendTiming?: { clear(): void } }).__tarobirdSendTiming?.clear());
    const composer = page.getByRole("textbox", { name: "消息", exact: true });
    await page.getByRole("button", { name: "工作台", exact: true }).click();
    await expect(page.getByRole("button", { name: "工作台", exact: true })).toHaveAttribute("aria-expanded", "true");
    await composer.focus();
    await composer.press("Control+Enter");
    const afterEmptyWorkbenchCtrlEnter = await page.evaluate(() => (window as unknown as { __tarobirdSendTiming?: { records: TimingRecord[] } }).__tarobirdSendTiming?.records ?? []);
    expect(afterEmptyWorkbenchCtrlEnter).toHaveLength(0);
    await page.getByRole("button", { name: "工作台", exact: true }).click();
    await expect(page.getByRole("button", { name: "工作台", exact: true })).toHaveAttribute("aria-expanded", "false");

    // 2. Scrolled-up main send: composerClearedAt stamps immediately, bubbleVisibleAt stamps after clicking "回到最新消息".
    const scroller = page.locator(".message-scroll");
    await scroller.evaluate(node => { node.scrollTop = 0; });
    await scroller.dispatchEvent("wheel", { deltaY: -120 });
    await expect(page.getByRole("button", { name: "回到最新消息", exact: true })).toBeVisible();

    await composer.fill("Scrolled up message");
    await page.getByRole("button", { name: "发送消息", exact: true }).click();
    await expect.poll(async () => page.evaluate(() => {
      const rec = (window as unknown as { __tarobirdSendTiming?: { latest(): TimingRecord | undefined } }).__tarobirdSendTiming?.latest();
      return rec ? { route: rec.route, cleared: rec.composerClearedAt !== undefined, read: rec.historyReadDoneAt !== undefined, visible: rec.bubbleVisibleAt !== undefined } : null;
    })).toEqual({ route: "queue", cleared: true, read: true, visible: false });

    await page.getByRole("button", { name: "回到最新消息", exact: true }).click();
    await expect(page.locator(".message.user").filter({ hasText: "Scrolled up message" })).toBeVisible();
    await expect.poll(async () => page.evaluate(() => {
      const rec = (window as unknown as { __tarobirdSendTiming?: { latest(): TimingRecord | undefined } }).__tarobirdSendTiming?.latest();
      return rec?.bubbleVisibleAt !== undefined;
    })).toBe(true);

    // 3. Side conversation: attachment-only send and repeated question both record bubbleVisibleAt cleanly.
    await page.evaluate(() => (window as unknown as { __tarobirdSendTiming?: { clear(): void } }).__tarobirdSendTiming?.clear());
    await page.getByRole("button", { name: "侧边对话", exact: true }).click();
    const panel = page.getByRole("complementary", { name: "侧边对话", exact: true });
    const sideInput = panel.getByRole("textbox", { name: "侧边问题", exact: true });
    await expect(sideInput).toBeEnabled();

    await sideInput.fill("Repeated side ask");
    await panel.getByRole("button", { name: "发送侧边问题", exact: true }).click();
    await expect(panel.getByText("Side reply #1: Repeated side ask")).toBeVisible();
    await expect.poll(async () => page.evaluate(() => {
      const rec = (window as unknown as { __tarobirdSendTiming?: { records: TimingRecord[] } }).__tarobirdSendTiming?.records[0];
      return rec ? { kind: rec.kind, visible: rec.bubbleVisibleAt !== undefined, cleared: rec.composerClearedAt !== undefined } : null;
    })).toEqual({ kind: "side", visible: true, cleared: true });

    // Repeat the exact same side question: must match the new exchange id, not the previous exchange.
    await sideInput.fill("Repeated side ask");
    await panel.getByRole("button", { name: "发送侧边问题", exact: true }).click();
    await expect(panel.getByText("Side reply #2: Repeated side ask")).toBeVisible();
    const sideRecords = await page.evaluate(() => (window as unknown as { __tarobirdSendTiming?: { records: TimingRecord[] } }).__tarobirdSendTiming?.records ?? []);
    expect(sideRecords).toHaveLength(2);
    expect(sideRecords[1]!.clientMsgId).not.toBe(sideRecords[0]!.clientMsgId);
    expect(sideRecords[1]!.bubbleVisibleAt).toBeDefined();
    expect(sideRecords[1]!.composerClearedAt).toBeDefined();

    // Attachment-only side send: has no .side-question element, yet bubbleVisibleAt must still be recorded.
    const pngBytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aL1sAAAAASUVORK5CYII=", "base64");
    await panel.locator('input[type="file"]').setInputFiles({ name: "dot.png", mimeType: "image/png", buffer: pngBytes });
    await panel.getByRole("button", { name: "发送侧边问题", exact: true }).click();
    await expect(panel.getByText("Side file reply (1)")).toBeVisible();
    await expect.poll(async () => page.evaluate(() => {
      const rec = (window as unknown as { __tarobirdSendTiming?: { latest(): TimingRecord | undefined } }).__tarobirdSendTiming?.latest();
      return rec ? { kind: rec.kind, len: rec.messageLength, visible: rec.bubbleVisibleAt !== undefined, cleared: rec.composerClearedAt !== undefined } : null;
    })).toEqual({ kind: "side", len: 0, visible: true, cleared: false });
  } finally {
    await gateway.disconnect();
    await hub.close();
    await rm(root, { recursive: true, force: true });
  }
});
