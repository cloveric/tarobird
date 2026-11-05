import { preparePairing } from "./fixtures/pairing-invite.js";
import { test, expect } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HubServer } from "../../src/hub/server.js";
import { colorPalettes } from "../src/palettes.js";
import { openSettings, closeSettings, selectPaletteForCoverage } from "./fixtures/settings.js";
import { showDisconnectedBots, selectConversation, waitForClientOnline } from "./fixtures/mobile.js";

test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, serviceWorkers: "block" });

test("scrolling past font size to choose a theme never changes the saved reading size", async ({ page, browserName }, info) => {
  test.skip(browserName !== "chromium", "Real touch scrolling uses Chromium's input driver; selection and persistence are covered separately.");
  test.setTimeout(120_000);
  const root = await mkdtemp(path.join(os.tmpdir(), "theme-font-size-"));
  const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve("dist") });
  try {
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','字号助手','fixture')");
    const chat = await hub.store.createConversation("owner", ["alpha"], "字号回归", "font");
    await hub.store.publishBotMessage("alpha", { conversationId: chat.id, blocks: [{ type: "text", text: "切换主题后，聊天正文应保持自己设置的字号。" }], status: "complete" });
    await page.goto(hub.url);
    await preparePairing(page, hub); await page.getByRole("button", { name: "配对此设备", exact: true }).click();
    await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
    await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" }); await showDisconnectedBots(page);
    await waitForClientOnline(page);
    const touch = await page.context().newCDPSession(page);
    for (const palette of colorPalettes) {
      await openSettings(page);
      const font = page.getByLabel("字号", { exact: true });
      await expect(font).toHaveValue("14");
      await font.scrollIntoViewIfNeeded();
      const bounds = (await font.boundingBox())!;
      const x = bounds.x + bounds.width * .85, y = bounds.y + bounds.height / 2;
      const before = await page.locator(".settings-content").evaluate(el => el.scrollTop);
      await touch.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
      for (let step = 1; step <= 8; step++) {
        await touch.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y: y - step * 15 }] });
      }
      await touch.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      await expect(font, `Swipe near the large-size end before ${palette.id}`).toHaveValue("14");
      await expect.poll(() => page.locator(".settings-content").evaluate(el => el.scrollTop)).toBeGreaterThan(before);
      await selectPaletteForCoverage(page, palette.id);
      await expect(font).toHaveValue("14");
      // All card content keeps a real inset, including in the CLI theme.
      expect(await font.evaluate(el => {
        const card = el.closest('.settings-group')!, box = card.getBoundingClientRect();
        return Array.from(card.querySelectorAll('label,select,output,.model-brand-toggle,.settings-font-preview,#model-brand-setting')).every(node => {
          const r = node.getBoundingClientRect(); return r.left >= box.left + 15 && r.right <= box.right - 15;
        });
      })).toBe(true);
      await closeSettings(page);
      await selectConversation(page, "字号回归");
      await expect(page.locator("html")).toHaveCSS("font-size", "14px");
      await expect(page.locator(".message.bot .markdown")).toHaveCSS("font-size", "14px");
    }
    await openSettings(page);
    const slider = page.getByRole("slider", { name: "字号", exact: true });
    for (const [from, to, expected] of [[.25, .75, 18], [.75, .25, 14]]) {
      await slider.scrollIntoViewIfNeeded();
      const box = (await slider.boundingBox())!, start = box.x + 12 + (box.width - 24) * from;
      const end = box.x + 12 + (box.width - 24) * to, y = box.y + box.height / 2;
      const before = await slider.inputValue();
      await touch.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: start, y }] });
      await expect(slider).toHaveValue(before); // No jump at touch-down.
      for (let step = 1; step <= 10; step++) {
        await touch.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: start + (end - start) * step / 10, y }] });
      }
      await touch.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      await expect(slider).toHaveValue(String(expected));
    }
    const bounds = (await slider.boundingBox())!;
    await touch.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: bounds.x + bounds.width * .9, y: bounds.y + 22 }] });
    await touch.send("Input.dispatchTouchEvent", { type: "touchCancel", touchPoints: [] });
    await expect(slider).toHaveValue("14");
    await page.screenshot({ path: info.outputPath("theme-font-preserved.png"), animations: "disabled" });
    await page.reload(); await waitForClientOnline(page); await openSettings(page);
    await expect(page.getByLabel("字号", { exact: true })).toHaveValue("14");
  } finally { await page.close(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});

for (const width of [390, 1360]) test(`chosen font size survives themes, chat navigation and reload at ${width}px`, async ({ page }, info) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width, height: 844 });
  const root = await mkdtemp(path.join(os.tmpdir(), "font-choice-"));
  const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve("dist") });
  try {
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','字号助手','fixture')");
    const chat = await hub.store.createConversation("owner", ["alpha"], "字号选择", "choice");
    const body = "正文大小应一致，切换主题后也保持。Same reading size: 123.";
    const user = (await hub.store.sendMessage("owner", { conversationId: chat.id, clientMsgId: "font-comparison", text: body, attachments: [] })).message;
    const plain = await hub.store.publishBotMessage("alpha", { conversationId: chat.id, blocks: [{ type: "text", text: body }], status: "complete" });
    const card = await hub.store.publishBotMessage("alpha", { conversationId: chat.id, blocks: [{ type: "card", title: "已完成", elements: [{ type: "markdown", text: body }] }], status: "complete" });
    await page.goto(hub.url);
    await preparePairing(page, hub); await page.getByRole("button", { name: "配对此设备", exact: true }).click();
    await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
    await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" }); await showDisconnectedBots(page);
    await waitForClientOnline(page);
    for (const [size, palette, theme] of [[12, "cli", "light"], [16, "white-green", "dark"], [20, "mono", "light"], [14, "mono", "system"]] as const) {
      await openSettings(page);
      const font = page.getByRole("slider", { name: "字号", exact: true });
      await font.focus();
      await font.press("Home");
      for (let step = 12; step < size; step++) await font.press("ArrowRight");
      await expect(page.locator(".settings-font-preview")).toHaveCSS("font-size", `${size}px`);
      await selectPaletteForCoverage(page, "mono");
      await page.getByLabel("主题", { exact: true }).selectOption(theme);
      await selectPaletteForCoverage(page, palette);
      await expect(font).toHaveValue(String(size));
      await closeSettings(page); await selectConversation(page, "字号选择");
      await expect(page.locator("html")).toHaveCSS("font-size", `${size}px`);
      await page.evaluate(() => document.fonts.ready);
      const userBody = page.locator(`[data-message-id="${user.id}"] .markdown > .markdown-chunk > p`).first();
      const family = await userBody.evaluate(el => getComputedStyle(el).fontFamily);
      for (const message of [user, plain, card]) {
        const paragraph = page.locator(`[data-message-id="${message.id}"] .markdown > .markdown-chunk > p`).first();
        await expect(paragraph).toHaveCSS("font-size", `${size}px`);
        await expect(paragraph).toHaveCSS("font-family", family);
        await expect(paragraph).toHaveCSS("font-weight", "400");
      }
      if (size === 14) await page.screenshot({ path: info.outputPath(`message-type-${width}.png`), animations: "disabled" });
      await page.reload(); await waitForClientOnline(page); await openSettings(page);
      await expect(page.getByLabel("字号", { exact: true })).toHaveValue(String(size));
      await closeSettings(page);
    }
    await openSettings(page);
    if (width === 390) await page.setViewportSize({ width: 320, height: 700 });
    await page.getByLabel("字号", { exact: true }).scrollIntoViewIfNeeded();
    expect(await page.locator(".settings-content").evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    if (width === 1360) {
      const track = page.locator('.font-size-slider'), box = (await track.boundingBox())!;
      await page.mouse.click(box.x + 12 + (box.width - 24) * .75, box.y + 22);
      await expect(page.locator('#font-size')).toHaveValue('18');
      await page.mouse.move(box.x + 12 + (box.width - 24) * .75, box.y + 22);
      await page.mouse.down();
      await page.mouse.move(box.x + 12 + (box.width - 24) * .25, box.y + 22, { steps: 10 });
      await page.mouse.up();
      await expect(page.locator('#font-size')).toHaveValue('14');
    }
    await page.screenshot({ path: info.outputPath(`font-picker-${width}.png`), animations: "disabled" });
  } finally { await page.close(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});

for (const width of [390, 1360]) test(`bold text inside Markdown headings keeps the heading weight at ${width}px`, async ({ page }, info) => {
  await page.setViewportSize({ width, height: 844 });
  const root = await mkdtemp(path.join(os.tmpdir(), "heading-emphasis-"));
  const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve("dist") });
  try {
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','层级助手','fixture')");
    const chat = await hub.store.createConversation("owner", ["alpha"], "标题层级", "heading");
    const text = "**有台风，而且是周末最明显。** 路径图已发给你。\n\n## 二、对上海的判断：**不会正面登陆，但周末受外围影响明显**\n\n位置：台湾以东近海，**距上海约 710 公里**。";
    const reply = await hub.store.publishBotMessage("alpha", { conversationId: chat.id, blocks: [{ type: "text", text }], status: "complete" });
    await page.goto(hub.url);
    await preparePairing(page, hub); await page.getByRole("button", { name: "配对此设备", exact: true }).click();
    await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
    await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" }); await showDisconnectedBots(page);
    await waitForClientOnline(page); await selectConversation(page, chat.title);
    const row = page.locator(`[data-message-id="${reply.id}"]`), heading = row.locator("h2");
    for (const palette of ["default", "cli"]) {
      if (palette !== "default") { await openSettings(page); await page.locator(`input[name="color-palette"][value="${palette}"]`).check(); await closeSettings(page); await selectConversation(page, chat.title); }
      const weight = await heading.evaluate(el => getComputedStyle(el).fontWeight);
      await expect(heading.locator("strong")).toHaveCSS("font-weight", weight);
      // Body emphasis uses the restrained shared reply weight; reading size stays unchanged.
      await expect(row.locator("p").first().locator("strong")).toHaveCSS("font-weight", "600");
      await expect(row.locator("p").first()).toHaveCSS("font-size", "14px");
      await expect(heading.locator("strong")).toHaveCSS("font-size", await heading.evaluate(el => getComputedStyle(el).fontSize));
      await row.screenshot({ path: info.outputPath(`heading-emphasis-${palette}-${width}.png`), animations: "disabled" });
    }
  } finally { await hub.close(); await rm(root, { recursive: true, force: true }); }
});
