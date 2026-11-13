import { test, expect } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { HubServer } from '../../src/hub/server.js';
import { createServer } from './fixtures/vite.js';
import { preparePairing } from './fixtures/pairing-invite.js';
import { selectConversation, showDisconnectedBots, waitForClientOnline } from './fixtures/mobile.js';

// Chromium exercises the real App/controller with simulated native reports.
// UIKit timing, keyboard pixels and caret alignment need separate native checks.
test.use({ viewport: { width: 430, height: 932 }, isMobile: true, hasTouch: true,
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1' });

test('iOS keyboard motion keeps the tail, reading position and draft through open, close and reversal', async ({ page }, info) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ios-keyboard-motion-'));
  const vite = await createServer({ plugins: [{ name: 'ios-keyboard-motion-fixture', enforce: 'pre', transform(code, id) {
    if (id.endsWith('/src/MobileViewport.tsx')) return code.replace('const platform = Capacitor.getPlatform();', "const platform = 'ios' as string;");
  } }], server: { host: '127.0.0.1', port: 0 } });
  await vite.listen(); const url = vite.resolvedUrls!.local[0]!;
  const hub = await HubServer.start({ stateDir: root, origins: [new URL(url).origin] });
  try {
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('motion','助手','fixture')");
    const chat = await hub.store.createConversation('owner', ['motion'], '键盘动画检查', 'direct');
    for (let i = 0; i < 40; i++) await hub.store.publishBotMessage('motion', { conversationId: chat.id, blocks: [{ type: 'text', text: `消息 ${i}：动画过程中保留正在阅读的位置和草稿。` }] });
    await page.addInitScript(() => { (window as any).tarobotKeyboardInsets = { supported: () => true }; });
    await page.goto(url); await page.getByLabel('Hub 地址', { exact: true }).fill(hub.url);
    await preparePairing(page, hub); await page.getByRole('button', { name: '配对此设备', exact: true }).click();
    await hub.auth.approve(await page.getByLabel('配对码', { exact: true }).innerText(), 'local-owner');
    await page.getByLabel('配对码', { exact: true }).waitFor({ state: 'hidden' });
    await waitForClientOnline(page); await showDisconnectedBots(page); await selectConversation(page, chat.title);
    await page.evaluate(() => { document.documentElement.dataset.platform = 'ios'; });
    const input = page.getByRole('textbox', { name: '消息', exact: true });
    await input.fill('保留草稿');
    const scroll = page.locator('.message-scroll');
    // The iOS virtual history can have a deferred spacer correction. Check
    // the painted tail used by App.tsx, not the spacer's temporary scrollHeight.
    const distance = () => scroll.evaluate(e => {
      const tail = e.querySelector('[data-index="39"]');
      return tail ? tail.getBoundingClientRect().bottom + parseFloat(getComputedStyle(e).paddingBottom) - (e.getBoundingClientRect().top + e.clientTop + e.clientHeight) : Infinity;
    });
    await expect.poll(async () => Math.abs(await distance())).toBeLessThan(3);
    const motion = (height: number, reverse = false) => page.evaluate(async ({ height, reverse }) => {
      const sc = document.querySelector('.message-scroll')!, shell = document.querySelector('.app-shell')!;
      const report = (height: number) => window.dispatchEvent(new CustomEvent('tarobot-keyboard', { detail: { height, at: Date.now(), duration: 383 } }));
      report(height);
      if (reverse) setTimeout(() => report(0), 90);
      const start = performance.now(), frames: Array<{ height: number; distance: number; top: number }> = [];
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
      const duration = getComputedStyle(shell).transitionDuration;
      const sample = () => {
        const tail = sc.querySelector('[data-index="39"]');
        frames.push({ height: shell.getBoundingClientRect().height,
          distance: tail ? tail.getBoundingClientRect().bottom + parseFloat(getComputedStyle(sc).paddingBottom) - (sc.getBoundingClientRect().top + sc.clientTop + sc.clientHeight) : Infinity,
          top: sc.scrollTop });
      };
      // Observe after the App's follow-tail observer, at the same layout pass.
      const observer = new ResizeObserver(sample); observer.observe(sc);
      while (performance.now() - start < 650) {
        await new Promise<void>(resolve => requestAnimationFrame(() => setTimeout(resolve, 0)));
      }
      observer.disconnect(); sample();
      return { frames, duration };
    }, { height, reverse });
    for (const height of [350, 0]) {
      const { frames, duration } = await motion(height);
      await info.attach(`motion-${height}.json`, { body: JSON.stringify(frames), contentType: 'application/json' });
      expect(duration).toBe(height ? '0.25s' : '0.383s');
      // Assert an actual intermediate geometry, not the host's rendering rate.
      expect(frames.some(frame => frame.height > 583 && frame.height < 931)).toBe(true);
      expect(frames.at(-1)!.height).toBeCloseTo(932 - height, 0);
      expect(Math.max(...frames.map(f => Math.abs(f.distance)))).toBeLessThan(4);
      await expect.poll(async () => Math.abs(await distance())).toBeLessThan(3);
    }
    const { frames: reversal } = await motion(350, true);
    expect(Math.min(...reversal.map(f => f.height))).toBeLessThan(920);
    expect(Math.max(...reversal.map(f => Math.abs(f.distance)))).toBeLessThan(4);
    expect(reversal.at(-1)!.height).toBeCloseTo(932, 0);
    await expect(page.locator('html')).not.toHaveAttribute('data-keyboard-motion');
    await scroll.hover(); await page.mouse.wheel(0, -1200);
    await expect(page.getByRole('button', { name: '回到最新消息', exact: true })).toBeVisible();
    // Wait for virtual-row measurement and inertia compensation to settle.
    await scroll.evaluate(async sc => {
      let prior = '', stable = 0;
      for (let i = 0; i < 120; i++) {
        await new Promise<void>(r => requestAnimationFrame(() => r()));
        const key = `${sc.scrollTop}/${sc.scrollHeight}`;
        stable = key === prior ? stable + 1 : 0; prior = key;
        if (stable >= 12) return;
      }
      throw Error('Reading position did not settle');
    });
    const before = await scroll.evaluate(e => e.scrollTop);
    for (const height of [350, 0]) {
      const { frames } = await motion(height);
      expect(Math.max(...frames.map(f => Math.abs(f.top - before)))).toBeLessThan(3);
    }
    // A real back action while the keyboard is open must keep the draft and
    // let the inbox/tab bar land sooner, without synthesizing an inset report.
    await motion(350);
    await page.getByRole('button', { name: '打开会话列表', exact: true }).click();
    await expect(page.locator('.app-shell')).toHaveClass(/mobile-home-open/);
    expect(await page.locator('html').getAttribute('data-keyboard-open')).toBe('true');
    const back = await motion(0);
    expect(back.duration).toBe('0.25s');
    await expect(page.getByRole('navigation', { name: '主导航', exact: true })).toBeVisible();
    const tabBottom = await page.locator('.mh-tabbar').evaluate(e => e.getBoundingClientRect().bottom);
    expect(tabBottom).toBeCloseTo(932, 0);
    await selectConversation(page, chat.title);
    await input.focus();
    const late = await page.evaluate(async () => {
      window.dispatchEvent(new CustomEvent('tarobot-keyboard', { detail: { height: 350, at: Date.now() - 300, duration: 383 } }));
      await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      const shell = document.querySelector('.app-shell')!;
      return { height: shell.getBoundingClientRect().height, transitions: shell.getAnimations().filter(a => a.playState === 'running').length };
    });
    // The report is newer than the OS duration but older than the chat cap.
    // It must land directly, rather than replaying the shorter page motion.
    expect(late.height).toBeCloseTo(582, 0); expect(late.transitions).toBe(0);
    await expect(input).toHaveValue('保留草稿');
    expect(await page.evaluate(() => scrollY)).toBe(0);
  } finally { await page.close(); await hub.close(); await vite.close(); await rm(root, { recursive: true, force: true }); }
});
