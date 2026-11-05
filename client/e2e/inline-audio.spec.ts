import { test, expect, type Page } from "@playwright/test";
import { createServer } from "./fixtures/vite.js";

async function fixture(page: Page, query: string, run: () => Promise<void>) {
  const server = await createServer({ server: { port: 0, host: "127.0.0.1" } }); await server.listen();
  try { await page.goto(server.resolvedUrls!.local[0] + `e2e/fixtures/inline-audio.html?${query}`); await run(); }
  finally { await page.close(); await server.close(); }
}

async function expectAudioOutsideCaption(page: Page) {
  const blocks = page.locator(".message-blocks"), caption = blocks.locator(":scope > .markdown"), audio = blocks.locator(":scope > .attachment-audio");
  await expect(caption).toBeVisible(); await expect(audio).toBeVisible();
  await expect(blocks).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await expect(blocks).toHaveCSS("padding", "0px");
  await expect(caption).not.toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  const textBox = (await caption.boundingBox())!, playerBox = (await audio.boundingBox())!, frame = (await blocks.boundingBox())!;
  expect(playerBox.y - textBox.y - textBox.height).toBeCloseTo(3, 0);
  expect(playerBox.x + playerBox.width).toBeCloseTo(textBox.x + textBox.width, 0);
  expect(playerBox.width).toBeLessThanOrEqual(frame.width + 1);
}

test("desktop voice controls really play, pause, seek, mute and replay", async ({ page }) => {
  await fixture(page, "platform=macos", async () => {
    const audio = page.locator("audio"), play = page.getByRole("button", { name: "播放语音", exact: true }), seek = page.getByRole("slider", { name: "播放进度" });
    await expect(seek).toBeEnabled(); await expect(audio).not.toHaveAttribute("controls");
    await play.click();
    await expect.poll(() => audio.evaluate((el: HTMLAudioElement) => el.currentTime)).toBeGreaterThan(.15);
    await page.getByRole("button", { name: "暂停语音", exact: true }).click();
    expect(await audio.evaluate((el: HTMLAudioElement) => el.paused)).toBe(true);
    await seek.fill("1.5");
    await expect.poll(() => audio.evaluate((el: HTMLAudioElement) => el.currentTime)).toBeCloseTo(1.5, 1);
    await seek.focus(); await page.keyboard.press("ArrowRight");
    await expect.poll(() => audio.evaluate((el: HTMLAudioElement) => el.currentTime)).toBeGreaterThan(1.5);
    const track = (await seek.boundingBox())!;
    await page.mouse.move(track.x + track.width / 2, track.y + track.height / 2); await page.mouse.down();
    await page.mouse.move(track.x + track.width * .8, track.y + track.height / 2); await page.mouse.up();
    await expect.poll(() => audio.evaluate((el: HTMLAudioElement) => el.currentTime / el.duration)).toBeGreaterThan(.65);
    await page.getByRole("button", { name: "静音", exact: true }).click();
    expect(await audio.evaluate((el: HTMLAudioElement) => el.muted)).toBe(true);
    await page.getByRole("button", { name: "取消静音", exact: true }).click();
    expect(await audio.evaluate((el: HTMLAudioElement) => el.muted)).toBe(false);
    await audio.evaluate((el: HTMLAudioElement) => { el.volume = 0; });
    await page.getByRole("button", { name: "取消静音", exact: true }).click();
    expect(await audio.evaluate((el: HTMLAudioElement) => !el.muted && el.volume > 0)).toBe(true);
    await audio.evaluate((el: HTMLAudioElement) => { el.currentTime = el.duration - .1; });
    await play.focus(); await page.keyboard.press("Enter");
    await expect.poll(() => audio.evaluate((el: HTMLAudioElement) => el.ended)).toBe(true);
    await play.click(); await expect.poll(() => audio.evaluate((el: HTMLAudioElement) => !el.paused && el.currentTime < 1)).toBe(true);
  });
});

test("inactive conversations pause; resize preserves the player; play rejection is retryable", async ({ page }) => {
  await fixture(page, "platform=macos", async () => {
    const audio = page.locator("audio"), play = page.getByRole("button", { name: "播放语音", exact: true });
    await expect(page.getByRole("slider")).toBeEnabled();
    await audio.evaluate((el: HTMLAudioElement) => { (window as any).originalAudio = el; (window as any).realPlay = el.play; el.play = () => Promise.reject(new DOMException("blocked", "NotAllowedError")); });
    await play.click(); await expect(page.getByRole("alert")).toHaveText("播放未能开始，请重试。");
    await audio.evaluate((el: HTMLAudioElement) => { el.play = (window as any).realPlay; });
    await play.click(); await expect(page.getByRole("button", { name: "暂停语音" })).toBeVisible(); await expect(page.getByRole("alert")).toHaveCount(0);
    await page.setViewportSize({ width: 600, height: 800 });
    expect(await audio.evaluate(el => el === (window as any).originalAudio)).toBe(true);
    await expect(page.getByRole("group", { name: "语音播放" })).toBeVisible();
    await page.evaluate(() => (window as any).audioFixture.setActive(false));
    await expect.poll(() => audio.evaluate((el: HTMLAudioElement) => el.paused)).toBe(true);
    await expect(play).toBeDisabled();
    await page.evaluate(() => (window as any).audioFixture.setActive(true));
    await play.click(); await page.evaluate(() => (window as any).audioFixture.setId("tone.mp3"));
    await expect.poll(() => page.evaluate(() => (window as any).originalAudio.paused)).toBe(true);
    await expect(page.getByRole("slider")).toBeEnabled(); await expect(play).toBeVisible();
  });
});

test("a pending play can be cancelled without a stale rejection overwriting the next play", async ({ page }) => {
  await fixture(page, "platform=macos", async () => {
    const audio = page.locator("audio"), play = page.getByRole("button", { name: "播放语音", exact: true });
    await expect(page.getByRole("slider")).toBeEnabled();
    await audio.evaluate((el: HTMLAudioElement) => {
      (window as any).realPlay = el.play;
      el.play = () => new Promise<void>((_resolve, reject) => { (window as any).rejectOldPlay = reject; });
    });
    await play.click();
    const cancel = page.getByRole("button", { name: "暂停语音", exact: true });
    await expect(cancel).toBeEnabled(); await cancel.click(); await expect(play).toBeVisible();
    await audio.evaluate((el: HTMLAudioElement) => { el.play = (window as any).realPlay; });
    await play.click(); await expect(cancel).toBeVisible();
    await page.evaluate(() => (window as any).rejectOldPlay(new Error("late failure")));
    await expect(page.getByRole("alert")).toHaveCount(0);
    await expect(cancel).toBeEnabled();
    expect(await audio.evaluate((el: HTMLAudioElement) => el.paused)).toBe(false);
  });
});

for (const [theme, width] of [["light", 300], ["dark", 240]] as const) test(`rounded voice bar fits ${width}px in ${theme} mode`, async ({ page }, info) => {
  await fixture(page, `width=${width}&theme=${theme}&caption`, async () => {
    const controls = page.getByRole("group", { name: "语音播放" });
    await expect(page.getByRole("slider")).toBeEnabled();
    expect(await controls.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
    const buttons = controls.locator("button");
    for (const button of await buttons.all()) expect((await button.boundingBox())!.width).toBeGreaterThanOrEqual(32);
    const slider = (await controls.getByRole("slider").boundingBox())!;
    expect(slider.width).toBeGreaterThanOrEqual(24);
    await expectAudioOutsideCaption(page);
    await page.locator(".message").screenshot({ path: info.outputPath(`desktop-voice-${theme}.png`) });
  });
});

for (const [platform, width] of [["web", 390], ["ios", 1024], ["android", 390], ["android", 320]] as const) test(`${platform} phone audio retains native controls at ${width}px`, async ({ page }, info) => {
  await page.setViewportSize({ width, height: 844 });
  await fixture(page, `platform=${platform}&caption`, async () => {
    await expect(page.locator("audio[controls]")).toBeVisible();
    await expect(page.getByRole("group", { name: "语音播放" })).toHaveCount(0);
    await expectAudioOutsideCaption(page);
    await page.locator(".message").screenshot({ path: info.outputPath(`voice-caption-${platform}-${width}.png`) });
  });
});
