import { preparePairing } from "./fixtures/pairing-invite.js";
import { test as base, expect, type Page, type TestInfo } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HubServer } from "../../src/hub/server.js";
import { showDisconnectedBots, selectConversation, waitForClientOnline } from "./fixtures/mobile.js";
import { settleReadingLayout } from "./fixtures/reading-position.js";

const test = base.extend<{ conversation: string }>({
  conversation: async ({ page }, use) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "composer-size-"));
    const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve("dist") });
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    try {
      await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','输入测试','fixture')");
      const chat = await hub.store.createConversation("owner", ["alpha"], "输入与阅读位置", "sizing");
      for (let i = 0; i < 20; i++) await hub.store.publishBotMessage("alpha", { conversationId: chat.id, blocks: [{ type: "text", text: `消息 ${i + 1}\n文件已准备好，可以继续输入说明。\n保持阅读位置。` }], status: "complete" });
      await page.goto(hub.url); await preparePairing(page, hub); await page.getByRole("button", { name: "配对此设备", exact: true }).click();
      await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
      await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" }); await showDisconnectedBots(page);
      await waitForClientOnline(page); await selectConversation(page, chat.title);
      await use(chat.title);
      expect(errors).toEqual([]);
    } finally { await page.close(); await hub.close(); await rm(root, { recursive: true, force: true }); }
  },
});
test.use({ viewport: { width: 1100, height: 760 }, serviceWorkers: "block" });
const attach = (page: Page) => page.locator('input[type="file"][multiple]').setInputFiles({ name: "image.png", mimeType: "image/png", buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jWKsAAAAASUVORK5CYII=", "base64") });

async function stableTyping(page: Page, info: TestInfo, stage: string, text: string) {
  await settleReadingLayout(page.locator(".message-scroll"));
  await page.evaluate(() => {
    const frames: Record<string, number>[] = []; let stopped = false;
    Object.assign(window, { typingFrames: frames, stopTypingFrames: () => { stopped = true; } });
    const sample = () => {
      const box = document.querySelector(".composer")!, input = box.querySelector("textarea")!, tray = box.querySelector(".attachment-draft"), scroll = document.querySelector(".message-scroll")!;
      frames.push({ top: box.getBoundingClientRect().top, height: box.getBoundingClientRect().height, inputHeight: input.getBoundingClientRect().height, trayTop: tray?.getBoundingClientRect().top ?? 0, scrollTop: scroll.scrollTop });
      if (!stopped) requestAnimationFrame(sample);
    };
    sample();
  });
  const input = page.getByRole("textbox", { name: "消息", exact: true });
  for (const char of text) await input.pressSequentially(char, { delay: 45 });
  await page.waitForTimeout(350);
  const frames = await page.evaluate(() => { (window as any).stopTypingFrames(); return (window as any).typingFrames as Record<string, number>[]; });
  await info.attach(`${stage}-geometry`, { body: JSON.stringify(frames), contentType: "application/json" });
  expect(frames.length).toBeGreaterThan(5);
  for (const property of ["top", "height", "inputHeight", "trayTop", "scrollTop"]) {
    const values = frames.map(frame => frame[property]!);
    expect(Math.max(...values) - Math.min(...values), `${stage}: ${property}`).toBeLessThanOrEqual(1);
  }
}

for (const attachment of [true, false]) test(`desktop typing preserves composer and reading position (attachment: ${attachment})`, async ({ page, conversation }, info) => {
  expect(conversation).toBeTruthy();
  if (attachment) {
    await attach(page);
    await expect(page.getByRole("region", { name: "待发送的附件", exact: true })).toContainText("image.png");
  }
  const input = page.getByRole("textbox", { name: "消息", exact: true });
  await input.fill("这个文件");
  await stableTyping(page, info, "latest", "是不是已经在本机了，继续确认一下。");
  await page.screenshot({ path: info.outputPath("desktop-typing.png") });
  await page.locator(".message-scroll").hover(); await page.mouse.wheel(0, -420);
  await expect(page.getByRole("button", { name: "回到最新消息", exact: true })).toBeVisible();
  await input.focus();
  await stableTyping(page, info, "history", "再补充几个字。");
});

test("desktop composer grows for newlines and wrapping, caps long drafts and shrinks after deletion", async ({ page, conversation }) => {
  expect(conversation).toBeTruthy();
  await attach(page);
  const input = page.getByRole("textbox", { name: "消息", exact: true });
  const height = () => input.evaluate(node => node.getBoundingClientRect().height);
  await input.fill("第一行");
  const short = await height(), line = await input.evaluate(node => parseFloat(getComputedStyle(node).lineHeight));
  await input.press("Shift+Enter"); await input.pressSequentially("第二行");
  await expect.poll(height).toBeGreaterThan(short);
  // The first row can be taller than its text because of the minimum input height.
  // Once above that floor, each additional newline should add one text line.
  const twoLines = await height();
  await input.press("Shift+Enter"); await input.pressSequentially("第三行");
  await expect.poll(async () => Math.abs(await height() - twoLines - line)).toBeLessThanOrEqual(1);
  await input.fill(Array.from({ length: 10 }, (_, i) => `第${i + 1}行`).join("\n"));
  const cap = await input.evaluate(node => { const style = getComputedStyle(node); return parseFloat(style.lineHeight) * 6 + parseFloat(style.paddingTop) + parseFloat(style.paddingBottom); });
  await expect.poll(async () => Math.abs(await height() - cap)).toBeLessThanOrEqual(1);
  expect(await input.evaluate(node => node.scrollHeight - node.clientHeight)).toBeGreaterThan(line * 3);
  await input.fill("保留一行");
  await expect.poll(async () => Math.abs(await height() - short)).toBeLessThanOrEqual(1);
  await input.fill("自动折行的内容".repeat(14));
  const wide = await height();
  await page.setViewportSize({ width: 820, height: 760 });
  await expect.poll(height).toBeGreaterThan(wide);
  await page.setViewportSize({ width: 1100, height: 760 });
  await expect.poll(async () => Math.abs(await height() - wide)).toBeLessThanOrEqual(1);
  await input.fill("");
  await expect.poll(async () => Math.abs(await height() - short)).toBeLessThanOrEqual(1);
  await expect(input).toBeFocused();
  await expect(page.getByRole("region", { name: "待发送的附件", exact: true }).getByRole("listitem")).toHaveCount(1);
});
