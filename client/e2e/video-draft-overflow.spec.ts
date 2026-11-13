import { test, expect, type Locator, type Page } from "@playwright/test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HubServer } from "../../src/hub/server.js";
import { preparePairing } from "./fixtures/pairing-invite.js";
import { showDisconnectedBots, selectConversation, waitForClientOnline } from "./fixtures/mobile.js";
import { openSettings, closeSettings } from "./fixtures/settings.js";
import en from "../src/locales/en.json" with { type: "json" };

const variants = [
  { name: "iphone", width: 430, height: 932, touch: true, platform: "ios" },
  { name: "compact-phone", width: 320, height: 568, touch: true },
  { name: "android", width: 360, height: 800, touch: true, platform: "android" },
  { name: "expanded-phone", width: 673, height: 841, touch: true, platform: "ios" },
  { name: "tablet", width: 820, height: 1180, touch: true, platform: "ios" },
  { name: "tablet-pointer", width: 820, height: 1180, touch: false, platform: "ios" },
  { name: "desktop", width: 1360, height: 900, touch: false },
  { name: "phone-send", width: 390, height: 844, touch: true, platform: "ios" },
];
async function reachable(button: Locator) {
  await expect(button).toBeInViewport({ ratio: .75 });
  // Bounding boxes alone can include pixels clipped by a flex ancestor.
  await expect.poll(() => button.evaluate(node => {
    const box = node.getBoundingClientRect(), hit = document.elementFromPoint(box.x + box.width / 2, box.y + Math.min(36, box.height / 2));
    return !!hit && node.contains(hit);
  })).toBe(true);
}
async function keyboard(page: Page, height: number, fullHeight: number) {
  await page.evaluate(value => (window as unknown as { draftQuotaKeyboard: (height: number) => void }).draftQuotaKeyboard(value), height);
  await expect(page.locator("html")).toHaveAttribute("data-keyboard-open", String(height < fullHeight));
  if (height < fullHeight) await expect.poll(() => page.evaluate(() => document.documentElement.style.getPropertyValue("--app-height"))).toBe(`${height}px`);
}
async function attachVideos(page: Page, clip: string) {
  await page.locator('input[type="file"][multiple]').first().evaluate((node, encoded) => {
    const bytes = Uint8Array.from(atob(encoded), char => char.charCodeAt(0));
    const transfer = new DataTransfer();
    // Valid media prefix with padding: two individually legal files exceed the
    // real 64 MiB offline draft budget. No storage-limit or File.size mock.
    for (const name of ["screen-one.mp4", "screen-two.mp4"]) transfer.items.add(new File([bytes, new Uint8Array(33 * 1024 * 1024 - bytes.length)], name, { type: "video/mp4" }));
    (node as HTMLInputElement).files = transfer.files;
    node.dispatchEvent(new Event("change", { bubbles: true }));
  }, clip);
}

for (const variant of variants) test(`oversized video draft keeps preview and removal reachable on ${variant.name}`, async ({ browser }, info) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "video-draft-overflow-"));
  const hub = await HubServer.start({ stateDir: directory, clientDir: process.env.TAROBOT_E2E_CLIENT_DIR ?? path.resolve("dist") });
  const context = await browser.newContext({ viewport: variant, hasTouch: variant.touch, serviceWorkers: "block", locale: "zh-CN" });
  await context.addInitScript(() => {
    const visual = Object.assign(new EventTarget(), { height: innerHeight, width: innerWidth, offsetTop: 0, offsetLeft: 0, scale: 1 });
    Object.defineProperty(window, "visualViewport", { configurable: true, value: visual });
    Object.assign(window, { draftQuotaKeyboard: (height: number) => { visual.height = height; visual.dispatchEvent(new Event("resize")); } });
  });
  const page = await context.newPage(), errors: string[] = [];
  const english = variant.name === "android", label = (key: keyof typeof en) => english ? en[key] : key;
  page.on("pageerror", error => errors.push(error.message));
  try {
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','附件助手','fixture')");
    const chat = await hub.store.createConversation("owner", ["alpha"], "视频草稿", "video-draft");
    await page.goto(hub.url); await preparePairing(page, hub); await page.getByRole("button", { name: "配对此设备", exact: true }).click();
    await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
    await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" });
    await showDisconnectedBots(page); await waitForClientOnline(page); await selectConversation(page, chat.title);
    if (english) {
      await openSettings(page); await page.getByLabel("语言", { exact: true }).selectOption("en"); await closeSettings(page, true);
      await page.locator(".mobile-home").getByRole("navigation").getByRole("button", { name: new RegExp(`^${en["消息"]}`) }).click();
      await page.locator(".mh-row").filter({ has: page.getByText(chat.title, { exact: true }) }).click();
    }
    // Exercise the platform CSS without claiming a native keyboard/picker test.
    if (variant.platform) await page.evaluate(platform => { document.documentElement.dataset.platform = platform; }, variant.platform);
    await attachVideos(page, (await readFile("e2e/fixtures/media/clip.mp4")).toString("base64"));
    const composer = page.locator(".host-workspace:not([hidden]) .composer"), tray = composer.getByRole("region", { name: label("待发送的附件"), exact: true });
    await expect(tray.getByRole("listitem")).toHaveCount(2);
    await expect(composer.getByRole("alert")).toContainText(english ? "Draft not saved automatically" : "草稿未自动保存");
    await expect(composer.getByRole("alert")).not.toContainText(/离线|offline/i);
    await expect(composer.locator(".draft-save-limits>summary")).toHaveText(label("本地草稿保存上限"));
    await expect.poll(() => composer.getByRole("alert").evaluate(node => node.scrollWidth - node.clientWidth)).toBeLessThanOrEqual(1);
    await expect(composer.getByRole("button", { name: label("发送消息"), exact: true })).toBeEnabled();
    await page.screenshot({ path: info.outputPath(`quota-${variant.name}.png`) });
    const open = tray.getByRole("button", { name: label("预览 {0}").replace("{0}", "screen-one.mp4"), exact: true });
    const remove = tray.getByRole("button", { name: label("移除 {0}").replace("{0}", "screen-two.mp4"), exact: true });
    await reachable(open); await reachable(remove);
    await open.click();
    const preview = page.getByRole("dialog", { name: label("附件预览"), exact: true });
    await expect(preview).toBeVisible(); await expect(preview.locator("video")).toBeVisible();
    await preview.getByRole("button", { name: label("关闭"), exact: true }).click();
    await expect(preview).toHaveCount(0);
    if (variant.name === "phone-send") {
      await composer.getByRole("button", { name: label("发送消息"), exact: true }).click();
      await expect(tray).toHaveCount(0, { timeout: 30_000 });
      await expect(composer.getByRole("alert")).toHaveCount(0);
      const messages = (await hub.store.snapshot("owner", chat.id)).messages;
      expect(messages).toHaveLength(1);
      expect(messages[0]!.blocks.filter(block => block.type === "file")).toHaveLength(2);
      expect(errors).toEqual([]); return;
    }
    // Long explanation and a keyboard-sized viewport must allow a real scroll
    // to the controls, not leave a one-pixel nested attachment viewport.
    await composer.locator(".draft-save-limits>summary").click();
    if (variant.touch) {
      await composer.getByRole("textbox", { name: label("消息"), exact: true }).fill("Keep these videos");
      await keyboard(page, Math.min(460, variant.height - 253), variant.height);
      if (variant.name === "compact-phone") {
        // A real scroll gesture must escape the tray at its end. Programmatic
        // scrollIntoView alone would hide a nested overscroll-containment bug.
        const box = (await tray.boundingBox())!;
        await page.mouse.move(box.x + 20, box.y + 20);
        await page.mouse.wheel(0, 180);
        await expect.poll(() => tray.evaluate(node => node.scrollTop)).toBeGreaterThan(0);
        await page.mouse.wheel(0, 180);
        await expect.poll(() => composer.evaluate(node => node.scrollTop)).toBeGreaterThan(0);
        const retry = composer.locator(".draft-save-error > button");
        await reachable(retry); await retry.click();
        await expect(tray.getByRole("listitem")).toHaveCount(2);
      }
      const field = composer.getByRole("textbox", { name: label("消息"), exact: true });
      await field.scrollIntoViewIfNeeded(); await reachable(field);
    }
    await open.scrollIntoViewIfNeeded(); await reachable(open);
    await remove.scrollIntoViewIfNeeded(); await reachable(remove);
    const send = composer.getByRole("button", { name: label("发送消息"), exact: true });
    await send.scrollIntoViewIfNeeded(); await reachable(send);
    if (variant.touch) await keyboard(page, variant.height, variant.height);
    // Deleting one file drops below the real draft budget and retries storage.
    await remove.click();
    await expect(tray.getByRole("listitem")).toHaveCount(1);
    await expect(composer.getByRole("alert")).toHaveCount(0);
    await expect(page.getByLabel(label("草稿状态"), { exact: true })).toHaveText(label("草稿已保存"));
    await page.reload(); await waitForClientOnline(page);
    if (variant.platform) await page.evaluate(platform => { document.documentElement.dataset.platform = platform; }, variant.platform);
    if (!english) await selectConversation(page, chat.title);
    else {
      const row = page.locator(".mh-row").filter({ has: page.getByText(chat.title, { exact: true }) });
      if (await row.isVisible()) await row.click();
    }
    await expect(tray).toContainText("screen-one.mp4");
    await expect(tray).not.toContainText("screen-two.mp4");
    expect(errors).toEqual([]);
  } finally { await context.close(); await hub.close(); await rm(directory, { recursive: true, force: true }); }
});
