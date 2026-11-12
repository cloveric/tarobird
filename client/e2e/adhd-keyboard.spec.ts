import { test, expect, type Page, type Locator } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HubServer } from "../../src/hub/server.js";
import { hashSecret } from "../../src/hub/auth.js";
import { attachGateway } from "../../src/gateway/service.js";
import { createCoreServiceRuntime } from "../../src/core/runtime.js";
import { preparePairing } from "./fixtures/pairing-invite.js";
import { createServer } from "./fixtures/vite.js";

const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148";
const IPAD = IPHONE.replace("(iPhone; CPU iPhone OS", "(iPad; CPU OS");
test.use({ serviceWorkers: "block" });

async function setup(page: Page, count: number) {
  const root = await mkdtemp(path.join(os.tmpdir(), "adhd-keyboard-"));
  // Select the shipping iOS controller and board policy; keep networking on
  // the isolated browser Hub. Do not inject a second controller or write its
  // height/keyboard flags by hand. UIKit delivery remains a native check.
  const vite = await createServer({ plugins: [{ name: "adhd-native-keyboard-fixture", enforce: "pre", transform(code, id) {
    if (id.endsWith("/src/MobileViewport.tsx")) return code.replace("const platform = Capacitor.getPlatform();", "const platform = 'ios' as string;");
    if (/\/src\/(adhd-board-state|ios-window)\.ts$/.test(id)) return code
      .replace('["ios", "android"].includes(', '["web", "ios", "android"].includes(')
      .replaceAll('platform === "ios"', 'platform === "web"').replaceAll("platform === 'ios'", "platform === 'web'");
  } }], server: { host: "127.0.0.1", port: 0 } });
  await vite.listen();
  const url = vite.resolvedUrls!.local[0]!;
  const hub = await HubServer.start({ stateDir: root, origins: [new URL(url).origin] });
  const gateways: Awaited<ReturnType<typeof attachGateway>>[] = [];
  const close = async () => { await page.close(); for (const gateway of gateways) await gateway.disconnect(); await hub.close(); await vite.close(); await rm(root, { recursive: true, force: true }); };
  try {
    await hub.profile.update({ name: "示例主机", revision: (await hub.profile.read()).revision });
    for (let i = 1; i <= count; i++) {
      const id = `helper-${i}`, title = `对话 ${i}`, stateDir = path.join(root, id);
      await mkdir(stateDir, { recursive: true }); await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ engine: "codex", locale: "zh" }));
      const secret = randomBytes(32).toString("base64url");
      await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES(?,?,?)", [id, `助手 ${i}`, hashSecret(secret)]);
      gateways.push(await attachGateway({ stateDir, url: hub.instanceUrl.replace("http", "ws") + "/instance", botId: id, secret, engine: "codex", runtime: createCoreServiceRuntime(), bridge: { handleAuthorizedMessage: async () => ({ text: "ok" }) } }));
      const chat = await hub.store.createConversation("owner", [id], title, title);
      await hub.store.publishBotMessage(id, { conversationId: chat.id, blocks: [{ type: "text", text: `${title}的第一条回复` }] });
    }
    await page.addInitScript(() => {
      Object.assign(window, { tarobotKeyboardInsets: { supported: () => true }, __tarobotKeyboard: { height: 0, at: Date.now(), duration: 0 } });
    });
    await page.goto(url); await page.getByLabel("Hub 地址", { exact: true }).fill(hub.url);
    await preparePairing(page, hub); await page.getByRole("button", { name: "配对此设备", exact: true }).click();
    await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
    await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" });
    await page.evaluate(() => document.documentElement.dataset.platform = "ios");
    await page.getByRole("button", { name: "打开 ADHD 模式", exact: true }).click();
    for (let i = 1; i <= count; i++) await page.getByRole("checkbox", { name: new RegExp(`^加入面板：.*对话 ${i}$`) }).check();
    await expect(page.locator(".adhd-card")).toHaveCount(count);
    return close;
  } catch (error) { await close(); throw error; }
}

async function keyboard(page: Page, height: number, duration = 0) {
  await page.evaluate(({ height, duration }) => {
    const report = { height, at: Date.now(), duration };
    Object.assign(window, { __tarobotKeyboard: report });
    window.dispatchEvent(new CustomEvent("tarobot-keyboard", { detail: report }));
  }, { height, duration });
  await expect(page.locator("html")).toHaveAttribute("data-keyboard-open", height ? "true" : "false");
}

async function assertReachable(card: Locator, band: number) {
  await expect.poll(() => card.evaluate((node, bottom) => {
    const grid = node.closest(".adhd-grid")!.getBoundingClientRect();
    return [".composer textarea", ".send-button"].map(selector => {
      const target = node.querySelector(selector)!; const rect = target.getBoundingClientRect();
      const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
      return rect.width > 0 && rect.height > 0 && rect.top >= Math.max(0, grid.top) && rect.bottom <= Math.min(bottom, grid.bottom) + 1 && !!hit && target.contains(hit);
    });
  }, band)).toEqual([true, true]);
}

for (const touch of [true, false]) test.describe(`iPad ADHD keyboard ${touch ? "touch" : "pointer"}`, () => {
  test.use({ userAgent: IPAD, hasTouch: touch, viewport: { width: 1194, height: 834 } });
  test("lower-row input and Send follow the keyboard, focus moves and split resize", async ({ page }, info) => {
    const close = await setup(page, 4);
    try {
      const cards = page.locator(".adhd-card"), lower = cards.nth(2), input = lower.getByRole("textbox");
      await input.fill("下排草稿保留");
      await keyboard(page, 420, 250);
      await assertReachable(lower, 414);
      await expect(input).toHaveValue("下排草稿保留");
      // Move focus without browser auto-scroll: the already-open keyboard
      // reports nothing new, so focusin itself must reveal the whole composer.
      const fourth = cards.nth(3), fourthInput = fourth.getByRole("textbox");
      await page.locator(".adhd-grid").evaluate(node => node.scrollTop = 0);
      await fourthInput.evaluate(node => node.focus({ preventScroll: true }));
      await assertReachable(fourth, 414);
      await fourthInput.pressSequentially("draft");
      await assertReachable(fourth, 414);
      await page.setViewportSize({ width: 800, height: 834 });
      await assertReachable(fourth, 414);
      await expect(fourthInput).toHaveValue("draft");
      await page.screenshot({ path: info.outputPath("ipad-split-keyboard.png") });
      // A repeated did-show report must not steal an intentional board scroll.
      await expect(page.locator("html")).not.toHaveAttribute("data-keyboard-motion");
      await page.locator(".adhd-grid").evaluate(node => node.scrollTop = 0);
      await keyboard(page, 420);
      // A broken repeat guard would schedule update, then reveal, in two frames.
      await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      await expect(page.locator(".adhd-grid")).toHaveJSProperty("scrollTop", 0);
      await keyboard(page, 0);
      await expect(input).toHaveValue("下排草稿保留");
      expect(await page.evaluate(() => window.scrollY)).toBe(0);
    } finally { await close(); }
  });
});

test.describe("Duo ADHD keyboard", () => {
  test.use({ userAgent: IPHONE, hasTouch: true, viewport: { width: 951, height: 669 } });
  test("a tall keyboard keeps the full focused composer visible without adding a third pane", async ({ page }, info) => {
    const close = await setup(page, 2);
    try {
      const card = page.locator(".adhd-card").last(), input = card.getByRole("textbox");
      await expect(page.locator(".adhd-shell")).toHaveAttribute("data-adhd-device", "phone");
      await input.fill("Duo 草稿");
      await keyboard(page, 340, 250);
      await assertReachable(card, 329);
      await keyboard(page, 370);
      await assertReachable(card, 299);
      await page.screenshot({ path: info.outputPath("duo-tall-keyboard.png") });
      await keyboard(page, 0);
      await expect(input).toHaveValue("Duo 草稿");
      await expect(page.locator(".adhd-card")).toHaveCount(2);
      expect(await page.evaluate(() => window.scrollY)).toBe(0);
    } finally { await close(); }
  });
});

for (const device of ["Duo touch", "iPad touch", "iPad pointer"]) test.describe(device, () => {
  test.use({ userAgent: device.startsWith("Duo") ? IPHONE : IPAD, hasTouch: !device.endsWith("pointer"), viewport: { width: 1000, height: 834 } });
  test("iOS ADHD controls respect the input-size floor and top safe area", async ({ page }) => {
    const close = await setup(page, 2);
    try {
      const input = page.locator(".adhd-card").first().getByRole("textbox");
      await page.getByLabel("ADHD 窗口字号", { exact: true }).selectOption("11");
      expect.soft(await input.evaluate(node => parseFloat(getComputedStyle(node).fontSize))).toBeGreaterThanOrEqual(16);
      // Only the editor has the input floor, not the user's reading-size choice.
      await expect(page.locator(".adhd-grid")).toHaveCSS("font-size", "11px");
      await page.evaluate(() => document.documentElement.style.setProperty("--safe-area-inset-top", "24px"));
      expect.soft(await page.getByRole("button", { name: "返回聊天", exact: true }).evaluate(node => node.getBoundingClientRect().top)).toBeGreaterThanOrEqual(24);
      // The iOS-scoped corrections must disappear for desktop/Android styles.
      for (const platform of ["web", "android"]) {
        await page.evaluate(value => document.documentElement.dataset.platform = value, platform);
        await expect(input).toHaveCSS("font-size", "11px");
        await expect(page.locator(".adhd-toolbar")).toHaveCSS("padding-top", "8px");
      }
    } finally { await close(); }
  });
});
