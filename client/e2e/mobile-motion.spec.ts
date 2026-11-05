import { preparePairing } from "./fixtures/pairing-invite.js";
import { test, expect, type Page } from '@playwright/test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { HubServer } from '../../src/hub/server.js';
import { openSettings, closeSettings } from './fixtures/settings.js';
import { mobileHome, openMobileHome, selectConversation, showDisconnectedBots, waitForClientOnline } from './fixtures/mobile.js';

test.use({ serviceWorkers: 'block', viewport: { width: 390, height: 844 }, hasTouch: true });
async function captureMotion(page: Page) {
  await page.addInitScript(() => {
    const original = Element.prototype.animate;
    (window as any).motionCalls = [];
    Element.prototype.animate = function(frames, options) {
      const animation = original.call(this, frames, options);
      (window as any).motionCalls.push({ target: this.className, frames, options, at: performance.now() });
      return animation;
    };
  });
}
const calls = (page: Page) => page.evaluate(() => (window as any).motionCalls as { target: string; frames: { transform: string }[]; options: { duration: number } }[]);
async function setup(page: Page) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mobile-motion-'));
  const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve('dist') });
  await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','研究助手','fixture')");
  const chat = await hub.store.createConversation('owner', ['alpha'], '动效验收', 'motion');
  const background = await hub.store.createConversation('owner', ['alpha'], '后台工作', 'background');
  for (let i = 0; i < 50; i++) await hub.store.publishBotMessage('alpha', { conversationId: chat.id, blocks: [{ type: 'text', text: `记录 ${i}：切换时保留阅读位置。\n${'历史内容。'.repeat(30)}` }], status: 'complete' });
  await captureMotion(page); await page.goto(hub.url);
  await preparePairing(page, hub); await page.getByRole('button', { name: '配对此设备', exact: true }).click();
  await hub.auth.approve(await page.getByLabel('配对码', { exact: true }).innerText(), 'local-owner');
  await page.getByLabel('配对码', { exact: true }).waitFor({ state: 'hidden' });
  await waitForClientOnline(page); await showDisconnectedBots(page);
  return { hub, chat, background, close: async () => { await page.close(); await hub.close(); await rm(root, { recursive: true, force: true }); } };
}

async function holdConversationEntry(page: Page) {
  await page.addInitScript(() => {
    const original = Element.prototype.animate;
    Element.prototype.animate = function(frames, options) {
      const animation = original.call(this, frames, options);
      // Hold the first visible frame so this exercises the actual hit target,
      // without locator stability waits silently skipping the entering phase.
      if (this.classList.contains('conversation-main')) { animation.pause(); animation.currentTime = 0; }
      return animation;
    };
  });
}

for (const input of ['mouse', 'touch'] as const) test(`the first ${input} click during page entry activates the control under the pointer`, async ({ page }) => {
  await holdConversationEntry(page);
  const h = await setup(page);
  try {
    await selectConversation(page, h.chat.title);
    const box = await page.getByRole('button', { name: '打开会话列表', exact: true }).boundingBox();
    expect(box).not.toBeNull();
    const x = box!.x + box!.width / 2, y = box!.y + box!.height / 2;
    if (input === 'touch') await page.touchscreen.tap(x, y);
    else await page.mouse.click(x, y);
    await expect(mobileHome(page)).toBeVisible();
  } finally { await h.close(); }
});

test('a delayed synthesized click keeps its hit target across rendering frames', async ({ page }) => {
  await holdConversationEntry(page);
  const h = await setup(page);
  try {
    await selectConversation(page, h.chat.title);
    const back = page.getByRole('button', { name: '打开会话列表', exact: true });
    const box = (await back.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    // Model the native release-to-synthesized-click gap without claiming this
    // is an iOS gesture test. A first-rAF cancellation would shift the button.
    await back.evaluate(async el => {
      el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerType: 'touch' }));
      await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    });
    expect((await back.boundingBox())!.x).toBeCloseTo(box.x, 1);
    await page.mouse.up();
    await expect(mobileHome(page)).toBeVisible();
  } finally { await h.close(); }
});

test('phone navigation is directional, short and interruptible without replaying on background messages', async ({ page }, info) => {
  const h = await setup(page);
  try {
    await expect(page.locator('html')).toHaveAttribute('data-motion', 'full');
    await selectConversation(page, h.chat.title);
    await expect.poll(async () => (await calls(page)).filter(c => c.target === 'conversation-main').length).toBe(1);
    const enter = (await calls(page)).find(c => c.target === 'conversation-main')!;
    expect(enter.options.duration).toBeLessThanOrEqual(200);
    expect(enter.frames[0]!.transform).toContain('28px');
    // An immediate native Back must take effect even inside the entering frame.
    await page.evaluate(() => window.dispatchEvent(new Event('tarocub-native-back', { cancelable: true })));
    await expect(mobileHome(page)).toBeVisible();
    const back = (await calls(page)).find(c => c.target === 'mobile-home')!;
    expect(back.frames[0]!.transform).toContain('-28px');
    await mobileHome(page).getByRole('button', { name: '我的', exact: true }).click();
    expect((await calls(page)).find(c => c.target === 'mh-body')!.options.duration).toBeLessThanOrEqual(140);
    await mobileHome(page).getByRole('navigation', { name: '主导航' }).getByRole('button', { name: /^消息/ }).click();
    await selectConversation(page, h.chat.title);
    await page.getByRole('textbox', { name: '消息', exact: true }).fill('连续切换后保留草稿');
    await expect(page.locator('.message')).not.toHaveCount(0);
    await page.locator('.message-scroll').hover(); await page.mouse.wheel(0, -1800);
    await expect(page.getByRole('button', { name: '回到最新消息', exact: true })).toBeVisible();
    await expect.poll(() => page.locator('.conversation-main').evaluate(el => el.getAnimations().length)).toBe(0);
    const before = await page.locator('.message-scroll').evaluate(el => el.scrollTop), count = (await calls(page)).length;
    await page.evaluate(() => {
      (window as any).motionFrames = [];
      let last = performance.now(), end = last + 800;
      (window as any).motionSampling = new Promise<void>(resolve => {
        const frame = (now: number) => { (window as any).motionFrames.push(now - last); last = now; if (now < end) requestAnimationFrame(frame); else resolve(); };
        requestAnimationFrame(frame);
      });
    });
    for (let i = 0; i < 12; i++) await h.hub.store.publishBotMessage('alpha', { conversationId: h.background.id, blocks: [{ type: 'text', text: `后台更新 ${i}` }], status: 'complete' });
    await expect.poll(async () => (await page.locator('.message-scroll').evaluate(el => el.scrollTop))).toBeCloseTo(before, 0);
    expect((await calls(page)).length).toBe(count);
    // Dispatch real navigation actions rapidly; no delayed exit may overwrite the latest one.
    for (let i = 0; i < 3; i++) {
      await page.evaluate(() => window.dispatchEvent(new Event('tarocub-native-back', { cancelable: true })));
      await expect(mobileHome(page)).toBeVisible();
      await mobileHome(page).locator(`[data-conversation-id="${h.chat.id}"]`).evaluate(el => (el as HTMLElement).click());
      await expect(page.getByRole('textbox', { name: '消息', exact: true })).toHaveValue('连续切换后保留草稿');
    }
    await page.getByRole('textbox', { name: '消息', exact: true }).dispatchEvent('pointerdown');
    expect(await page.locator('.conversation-main').evaluate(el => el.getAnimations().every(animation => animation.playState === 'paused'))).toBe(true);
    await page.getByRole('textbox', { name: '消息', exact: true }).dispatchEvent('pointercancel');
    await expect.poll(() => page.locator('.conversation-main').evaluate(el => el.getAnimations().length)).toBe(0);
    await page.evaluate(() => (window as any).motionSampling);
    const frames = await page.evaluate(() => (window as any).motionFrames as number[]);
    await writeFile(info.outputPath('navigation-motion.json'), JSON.stringify({ calls: await calls(page), frameGapsMs: frames, nativeDevice: false }, null, 2));
    await page.screenshot({ path: info.outputPath('phone-after-fast-navigation.png') });
  } finally { await h.close(); }
});

test('animations stay enabled without a device switch despite legacy off values and live OS reduced motion', async ({ page }, info) => {
  const h = await setup(page);
  try {
    // Full-screen settings animate the arriving section with WAAPI. Interrupt
    // that actual animation before Playwright's normal stability wait.
    await page.evaluate(() => {
      const original = Element.prototype.animate;
      Element.prototype.animate = function(frames, options) {
        const animation = original.call(this, frames, options);
        if (this.matches('.settings-navigation, .settings-content')) {
          Element.prototype.animate = original;
          queueMicrotask(() => {
            const before = animation.playState;
            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Shift', bubbles: true }));
            (window as any).settingsEntryInterruption = { before, after: animation.playState };
          });
        }
        return animation;
      };
    });
    await openSettings(page);
    expect(await page.evaluate(() => (window as any).settingsEntryInterruption)).toEqual({ before: 'running', after: 'idle' });
    const toggle = page.getByRole('switch', { name: '界面动画', exact: true });
    await expect(toggle).toHaveCount(0);
    await expect(page.locator('html')).toHaveAttribute('data-motion', 'full');
    await page.screenshot({ path: info.outputPath('settings-without-motion-switch.png') });
    // Reproduce an upgrade with the old off value in both persisted sources.
    await page.evaluate(async () => {
      const mirror = JSON.parse(localStorage.getItem('tarocub-appearance')!);
      localStorage.setItem('tarocub-appearance', JSON.stringify({ ...mirror, animations: false }));
      await new Promise<void>((resolve, reject) => {
        const open = indexedDB.open('tarocub-hosts-v1');
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const db = open.result, tx = db.transaction('meta', 'readwrite');
          const read = tx.objectStore('meta').get('preferences');
          read.onsuccess = () => tx.objectStore('meta').put(JSON.stringify({ ...mirror, ...JSON.parse(read.result ?? '{}'), animations: false }), 'preferences');
          tx.oncomplete = () => { db.close(); resolve(); };
          tx.onabort = () => { db.close(); reject(tx.error); };
        };
      });
    });
    await page.reload(); await waitForClientOnline(page);
    await expect(page.locator('html')).toHaveAttribute('data-motion', 'full');
    await openSettings(page); await expect(toggle).toHaveCount(0);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await expect(page.locator('html')).toHaveAttribute('data-motion', 'full');
    const reducedCount = (await calls(page)).length;
    await closeSettings(page); await selectConversation(page, h.chat.title); await openMobileHome(page);
    expect((await calls(page)).length).toBeGreaterThan(reducedCount);
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await expect(page.locator('html')).toHaveAttribute('data-motion', 'full');
    await selectConversation(page, h.chat.title);
    expect((await calls(page)).length).toBeGreaterThan(reducedCount);
  } finally { await h.close(); }
});
