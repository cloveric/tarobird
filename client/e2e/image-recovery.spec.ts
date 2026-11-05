import { test, expect } from '@playwright/test';
import { createServer } from './fixtures/vite.js';
import type { ViteDevServer } from 'vite';
declare global { interface Window { imageRecovery: { setStatus(status: string): void; failures: Set<string>; corrupt: Set<string>; calls: Record<string, number>; hold: boolean; release(): void; setLocale(locale: 'zh' | 'en'): void } } }
let server: ViteDevServer;
test.beforeAll(async () => { server = await createServer({ server: { host: '127.0.0.1', port: 0 } }); await server.listen(); });
test.afterAll(async () => { await server?.close(); });
test.beforeEach(async ({ page }) => { await page.setViewportSize({ width: 320, height: 740 }); await page.goto(server.resolvedUrls!.local[0] + 'e2e/fixtures/image-recovery.html'); });

test('disabled attachment consumers release their original and reacquire it when enabled', async ({ page }) => {
  await page.evaluate(() => (window as any).resourceProbe.setEnabled(true));
  await expect.poll(() => page.evaluate(() => !!(window as any).resourceProbe.url)).toBe(true);
  const original = await page.evaluate(() => (window as any).resourceProbe.url as string);
  await page.evaluate(() => (window as any).resourceProbe.setEnabled(false));
  await expect.poll(() => page.evaluate(() => (window as any).resourceProbe.hasBlob)).toBe(false);
  expect(await page.evaluate(url => fetch(url).then(() => true, () => false), original)).toBe(false);
  await page.evaluate(() => (window as any).resourceProbe.setEnabled(true));
  await expect.poll(() => page.evaluate(() => window.imageRecovery.calls['5'])).toBe(2);
  await expect.poll(() => page.evaluate(() => !!(window as any).resourceProbe.url)).toBe(true);
});

test('failed gallery tiles remain contained and retry independently while the host stays online', async ({ page }, info) => {
  const tiles = page.locator('.attachment-image');
  await expect(tiles.nth(2).getByRole('alert')).toContainText('图片加载失败');
  await expect(tiles.nth(3).getByRole('alert')).toContainText('图片加载失败');
  await expect(page.locator('body')).not.toContainText('unexpected end of stream');
  await expect(page.locator('body')).not.toContainText('203.0.113.10');
  const originals = await tiles.locator('img').evaluateAll(nodes => nodes.map(node => (node as HTMLImageElement).src));
  for (const width of [320, 390]) {
    await page.setViewportSize({ width, height: 740 });
    for (const tile of [tiles.nth(2), tiles.nth(3)]) {
      const box = (await tile.boundingBox())!, button = (await tile.getByRole('button', { name: '重新加载图片' }).boundingBox())!;
      expect(await tile.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
      expect(button.height).toBeGreaterThanOrEqual(44); expect(button.x).toBeGreaterThanOrEqual(box.x); expect(button.x + button.width).toBeLessThanOrEqual(box.x + box.width + 1);
    }
    await page.screenshot({ path: info.outputPath(`failed-gallery-${width}.png`) });
  }
  await page.evaluate(() => { window.imageRecovery.failures.delete('3'); window.imageRecovery.hold = true; });
  // Two queued clicks must share a single attempt and not reload healthy tiles.
  await tiles.nth(2).getByRole('button', { name: '重新加载图片' }).evaluate(node => { (node as HTMLButtonElement).click(); (node as HTMLButtonElement).click(); });
  await expect(tiles.nth(2).getByRole('status')).toContainText('加载图片');
  expect(await page.evaluate(() => window.imageRecovery.calls)).toEqual({ '1': 1, '2': 1, '3': 2, '4': 1 });
  await page.evaluate(() => { window.imageRecovery.hold = false; window.imageRecovery.release(); });
  await expect(tiles.nth(2).locator('img')).toBeVisible();
  expect(await tiles.locator('img').evaluateAll(nodes => nodes.slice(0, 2).map(node => (node as HTMLImageElement).src))).toEqual(originals);
  await expect(tiles.nth(3).getByRole('alert')).toBeVisible();
  await page.evaluate(() => window.imageRecovery.setLocale('en'));
  await expect(tiles.nth(3).getByRole('alert')).toContainText('Image could not load');
  await expect(tiles.nth(3).getByRole('button', { name: 'Reload image' })).toBeVisible();
});

test('a failed gallery selection can recover inside the reader without closing it', async ({ page }) => {
  await page.getByRole('button', { name: '图片 1', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '图片预览' });
  await dialog.getByRole('button', { name: '下一张' }).click();
  await dialog.getByRole('button', { name: '下一张' }).click();
  await expect(dialog.getByRole('alert')).toContainText('图片加载失败');
  await expect(dialog).not.toContainText('unexpected end of stream');
  await page.evaluate(() => window.imageRecovery.failures.delete('3'));
  await dialog.getByRole('button', { name: '重新加载图片' }).click();
  await expect(dialog.locator('img')).toBeVisible();
  await expect(dialog.getByLabel('图片位置')).toHaveText('3 / 4');
  await expect(dialog.getByRole('button', { name: '放大图片' })).toBeEnabled();
  await dialog.getByRole('button', { name: '放大图片' }).click();
  await expect(dialog.getByRole('button', { name: '还原图片' })).toBeVisible();
  await dialog.getByRole('button', { name: '关闭', exact: true }).click();
  await expect(dialog).toHaveCount(0);
});

test('already loaded originals stay readable through disconnect and reconnect while failed tiles recover', async ({ page }) => {
  const tile = page.locator('.attachment-image').first();
  await expect(tile.locator('img')).toBeVisible();
  const original = await tile.locator('img').getAttribute('src');
  await tile.getByRole('button', { name: '图片 1', exact: true }).click();
  const reader = page.getByRole('dialog', { name: '图片预览', exact: true });
  await expect(reader.locator('img')).toBeVisible();
  await page.evaluate(() => { window.imageRecovery.failures.add('1'); window.imageRecovery.setStatus('offline'); });
  await expect(reader.locator('img')).toHaveAttribute('src', original!);
  await expect(tile.locator('img')).toHaveAttribute('src', original!);
  await page.evaluate(() => { window.imageRecovery.failures.clear(); window.imageRecovery.setStatus('online'); });
  await expect(page.locator('.attachment-image').nth(2).locator('img')).toBeAttached();
  await expect(reader.locator('img')).toHaveAttribute('src', original!);
  expect(await page.evaluate(() => window.imageRecovery.calls['1'])).toBe(1);
});

test('downloaded but undecodable tiles show a usable recovery state', async ({ page }) => {
  const tile = page.locator('.attachment-image').nth(2);
  await expect(tile.getByRole('alert')).toBeVisible();
  await page.evaluate(() => { window.imageRecovery.failures.delete('3'); window.imageRecovery.corrupt.add('3'); });
  await tile.getByRole('button', { name: '重新加载图片' }).click();
  await expect(tile.getByRole('alert')).toContainText('此设备无法预览该文件');
  await expect(tile.getByRole('button', { name: '另存为', exact: true })).toBeVisible();
});
