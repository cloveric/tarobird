import { preparePairing } from "./fixtures/pairing-invite.js";
import { test, expect, type Locator } from "@playwright/test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HubServer } from "../../src/hub/server.js";
import { showDisconnectedBots, selectConversation, waitForClientOnline } from "./fixtures/mobile.js";

// Measure real hit targets, not just a 44px box covered by a neighbouring image.
async function expectFullTarget(button: Locator) {
  await button.scrollIntoViewIfNeeded();
  const hit = await button.evaluate(node => {
    const r = node.getBoundingClientRect();
    return { height: r.height, edges: [2, r.height / 2, r.height - 2].map(y => node.contains(document.elementFromPoint(r.x + r.width / 2, r.y + y))) };
  });
  expect(hit.height).toBeGreaterThanOrEqual(44);
  expect(hit.edges).toEqual([true, true, true]);
}

for (const width of [320, 390]) test(`phone attachments omit toolbars and reply sources retain unoccluded touch targets (${width})`, async ({ browser }, info) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "porcelain-touch-"));
  const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve("dist") });
  const context = await browser.newContext({ viewport: { width, height: 844 }, hasTouch: true, serviceWorkers: "block", reducedMotion: "reduce" });
  const page = await context.newPage();
  try {
    await hub.profile.update({ name: "示例主机", revision: (await hub.profile.read()).revision });
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','助手','fixture')");
    const chat = await hub.store.createConversation("owner", ["alpha"], "触屏布局", "touch");
    const bytes = await readFile("src/assets/bot-avatars/hamster.webp");
    const upload = await hub.attachments.create("owner", { conversationId: chat.id, name: "图片.webp", mime: "image/webp", size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
    await hub.attachments.putChunk("owner", upload.id, 0, bytes); await hub.attachments.complete("owner", upload.id);
    const { message: sent } = await hub.store.sendMessage("owner", { conversationId: chat.id, clientMsgId: "image", text: "请看看这张图", attachments: [upload.id] });
    const reply = await hub.store.publishBotMessage("alpha", { conversationId: chat.id, replyTo: sent.id, blocks: [{ type: "text", text: "[查看说明](https://example.com)\n\n已收到图片。" }] });
    await page.goto(hub.url); await preparePairing(page, hub); await page.getByRole("button", { name: "配对此设备", exact: true }).click();
    await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
    await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" });
    await waitForClientOnline(page); await showDisconnectedBots(page); await selectConversation(page, chat.title);
    const user = page.locator(`[data-message-id="${sent.id}"]`), bot = page.locator(`[data-message-id="${reply.id}"]`);
    await expect(user.locator(".image-thumbnail img")).toBeVisible();
    for (const platform of ["android", "ios"]) for (const palette of ["white-violet", "mono"]) for (const theme of ["light", "dark"]) {
      await page.evaluate(settings => Object.assign(document.documentElement.dataset, settings), { platform, palette, theme });
      await expect(user.locator(".attachment-message-actions")).toHaveCount(0);
      const source = bot.getByRole("button", { name: "查看回复对应的消息", exact: true });
      await expectFullTarget(source);
      const geometry = await bot.evaluate(node => {
        const s = node.querySelector(".bot-reply-source")!.getBoundingClientRect(), m = node.querySelector(".message-meta")!.getBoundingClientRect(), b = node.querySelector(".message-blocks")!.getBoundingClientRect();
        const label = node.querySelector(".bot-reply-source-label")!.getBoundingClientRect();
        return { top: s.top - m.bottom, bottom: b.top - s.bottom, labelGap: label.top - m.bottom };
      });
      expect(geometry.top).toBeGreaterThanOrEqual(0); expect(geometry.bottom).toBeGreaterThanOrEqual(0);
      // The visible label should not leave a blank band under the author/time.
      expect(geometry.labelGap).toBeLessThanOrEqual(14);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      if (width === 390 && platform === "ios" && palette === "white-violet") await page.screenshot({ path: info.outputPath(`touch-${theme}.png`), animations: "disabled" });
    }
    await bot.getByRole("button", { name: "查看回复对应的消息", exact: true }).click();
    await expect(user).toHaveClass(/focused-message/);
  } finally { await context.close(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});

async function expectReadablePreview(preview: Locator, selector = "strong,.link-preview-site,.link-preview-description,.link-preview-toggle,.link-preview-inline>svg") {
  const colors = await preview.evaluate((node, selector) => {
    const rgb = (color: string) => color.match(/[\d.]+/g)!.slice(0, 3).map(value => Number(value) * (color.startsWith("color(") ? 255 : 1));
    const luminance = (rgb: number[]) => {
      const channels = rgb.map(value => {
        value /= 255; return value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4;
      });
      return channels[0]! * .2126 + channels[1]! * .7152 + channels[2]! * .0722;
    };
    return [...node.querySelectorAll(selector)].map(element => {
      let background = "rgb(255, 255, 255)";
      let opacity = 1;
      for (let ancestor: Element | null = element; ancestor; ancestor = ancestor.parentElement) {
        opacity *= Number(getComputedStyle(ancestor).opacity);
        const color = getComputedStyle(ancestor).backgroundColor;
        if (color !== "rgba(0, 0, 0, 0)") { background = color; break; }
      }
      const bg = rgb(background), fg = rgb(getComputedStyle(element).color);
      const a = luminance(fg.map((value, i) => value * opacity + bg[i]! * (1 - opacity))), b = luminance(bg);
      return { label: element.textContent || element.tagName, ratio: (Math.max(a, b) + .05) / (Math.min(a, b) + .05) };
    });
  }, selector);
  expect(colors.length).toBeGreaterThan(0);
  for (const color of colors) expect(color.ratio, color.label).toBeGreaterThanOrEqual(4.5);
}

for (const width of [320, 390, 1360]) test(`link previews stay readable beside attachments and inside text bubbles (${width})`, async ({ browser }, info) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "porcelain-links-"));
  const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve("dist") });
  const context = await browser.newContext({ viewport: { width, height: 900 }, serviceWorkers: "block", reducedMotion: "reduce" });
  const page = await context.newPage();
  try {
    await hub.profile.update({ name: "示例主机", revision: (await hub.profile.read()).revision });
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','助手','fixture')");
    const chat = await hub.store.createConversation("owner", ["alpha"], "链接阅读", "links");
    const source = await hub.store.publishBotMessage("alpha", { conversationId: chat.id, blocks: [{ type: "text", text: "参考实现：\n\n```js\nconst answer = compute(\"value\");\n```\n\n行内 `inline code` 也应可读。" }] });
    const preview = (url: string) => ({ url, status: "ready" as const, title: "设计说明", description: "可展开的说明正文", siteName: "示例网站" });
    hub.linkPreviews.read = async url => preview(url);
    const messages: string[] = [];
    for (const kind of ["image", "file", "text", "audio"] as const) {
      const attachments: string[] = [];
      if (kind !== "text") {
        const bytes = kind === "image" ? await readFile("src/assets/bot-avatars/hamster.webp") : kind === "audio" ? await readFile("e2e/fixtures/media/tone.m4a") : Buffer.from("附件原文");
        const upload = await hub.attachments.create("owner", { conversationId: chat.id, name: kind === "image" ? "图片.webp" : kind === "audio" ? "语音.m4a" : "说明.txt", mime: kind === "image" ? "image/webp" : kind === "audio" ? "audio/mp4" : "text/plain", size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
        await hub.attachments.putChunk("owner", upload.id, 0, bytes); await hub.attachments.complete("owner", upload.id); attachments.push(upload.id);
      }
      const url = `https://example.org/${kind}`;
      const { message } = await hub.store.sendMessage("owner", { conversationId: chat.id, clientMsgId: kind, text: `参考说明 ${url}`, attachments, previewStyle: "inline", replyTo: source.id });
      await hub.store.setLinkPreview(message.id, preview(url)); messages.push(message.id);
    }
    await page.goto(hub.url); await preparePairing(page, hub); await page.getByRole("button", { name: "配对此设备", exact: true }).click();
    await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
    await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" });
    await waitForClientOnline(page); await showDisconnectedBots(page); await selectConversation(page, chat.title);
    for (const palette of ["mono", "white-violet", "cli"]) for (const theme of ["light", "dark"]) {
      await page.evaluate(settings => Object.assign(document.documentElement.dataset, settings), { palette, theme });
      for (const id of messages) {
        const row = page.locator(`[data-message-id="${id}"]`), link = row.locator(".message-link-preview");
        await link.scrollIntoViewIfNeeded(); await expectReadablePreview(link);
        const expand = link.getByRole("button", { name: "展开链接详情", exact: true });
        await expand.hover(); await expectReadablePreview(link); await expand.click();
        await expect(link.locator(".link-preview-description")).toBeVisible(); await expectReadablePreview(link);
        await link.getByRole("button", { name: "收起链接详情", exact: true }).click();
        await page.mouse.move(0, 0); await expectReadablePreview(link);
        const quote = row.locator(".quoted-message"), expandQuote = quote.getByRole("button", { name: "展开预览", exact: true });
        if (await expandQuote.count()) await expandQuote.click();
        if (palette === "mono" || palette === "white-violet") {
          await expectReadablePreview(quote, "p,pre,code,.hljs-keyword,.hljs-string,.hljs-title,.rich-preview-toggle");
        }
        await expect(row.locator(".attachment-message-actions")).toHaveCount(0);
        expect(await row.evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
        if (palette === "mono" && id === messages[0]) await row.screenshot({ path: info.outputPath(`links-${width}-${theme}.png`), animations: "disabled" });
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    }
  } finally { await context.close(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});
