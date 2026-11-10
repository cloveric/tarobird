import { test, expect } from '@playwright/test';
import { createServer } from './fixtures/vite.js';
import type { ViteDevServer } from 'vite';

// Actual DOM focus and pointer handling; not a physical iOS keyboard receipt.
test.use({ hasTouch: true, viewport: { width: 900, height: 650 }, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X)' });
let server: ViteDevServer;
test.beforeAll(async () => { server = await createServer({ server: { host: '127.0.0.1', port: 0 } }); await server.listen(); });
test.afterAll(async () => { await server?.close(); });
test.beforeEach(async ({ page }) => { await page.goto(server.resolvedUrls!.local[0] + 'e2e/fixtures/ios-keyboard-dismiss.html'); });

test('ordinary and folded iPhones retain focus in portrait and landscape', async ({ page }) => {
  const input = page.getByRole('textbox', { name: 'Draft' });
  for (const [width, height] of [[320, 568], [375, 667], [390, 844], [430, 932], [440, 956], [466, 678]]) {
    for (const [w, h] of [[width, height], [height, width]]) {
      await page.setViewportSize({ width: w!, height: h! }); await input.focus();
      await page.locator('#history').dispatchEvent('pointerdown', { pointerType: 'touch', pointerId: 1 });
      await page.locator('#history').dispatchEvent('pointerup', { pointerType: 'touch', pointerId: 1 });
      await expect(input).toBeFocused(); await expect(input).toHaveValue('Keep this draft');
    }
  }
});

test('folding between touch down and up cancels the expanded keyboard gesture', async ({ page }) => {
  const input = page.getByRole('textbox', { name: 'Draft' });
  await input.focus();
  await page.locator('#history').dispatchEvent('pointerdown', { pointerType: 'touch', pointerId: 1 });
  await page.setViewportSize({ width: 430, height: 932 });
  await page.locator('#history').dispatchEvent('pointerup', { pointerType: 'touch', pointerId: 1 });
  await expect(input).toBeFocused();
});

test('an iOS chat tap dismisses focus without losing the draft, even with no keyboard report', async ({ page }) => {
  const input = page.getByRole('textbox', { name: 'Draft' });
  await input.focus(); await page.locator('#history').tap();
  await expect(input).not.toBeFocused(); await expect(input).toHaveValue('Keep this draft');
  await page.evaluate(() => (window as any).disposeDismiss());
  await input.focus();
  await page.locator('#history').dispatchEvent('pointerdown', { pointerType: 'touch', pointerId: 1 });
  await page.locator('#history').dispatchEvent('pointerup', { pointerType: 'touch', pointerId: 1 });
  await expect(input).toBeFocused();
});

test('scrolls, long presses, text selection, controls and mouse gestures do not dismiss', async ({ page }) => {
  const input = page.getByRole('textbox', { name: 'Draft' });
  await input.focus();
  const gesture = async (target: string, type: string, move = false) => {
    const node = page.locator(target), event = { pointerType: type, pointerId: 1, clientX: 20, clientY: 20 };
    await node.dispatchEvent('pointerdown', event);
    if (move) await node.dispatchEvent('pointermove', { ...event, clientY: 60 });
    await node.dispatchEvent('pointerup', event);
    await expect(input).toBeFocused();
  };
  await gesture('#history', 'mouse'); await gesture('#history', 'touch', true);
  await gesture('#action', 'touch'); await gesture('label', 'touch');
  await page.locator('#history').dispatchEvent('pointerdown', { pointerType: 'touch', pointerId: 1 });
  await page.waitForTimeout(400);
  await page.locator('#history').dispatchEvent('pointerup', { pointerType: 'touch', pointerId: 1 });
  await expect(input).toBeFocused();
  await page.evaluate(() => { const range = document.createRange(); range.selectNodeContents(document.querySelector('#history')!); const selection = getSelection()!; selection.removeAllRanges(); selection.addRange(range); });
  await gesture('#history', 'touch');
});
