import { test, expect } from '@playwright/test';
import { createServer } from './fixtures/vite.js';

for (const platform of ['android', 'ios']) test(`${platform} image preview saves original bytes, handles failures and shares independently`, async ({ page, browserName }, info) => {
  const server = await createServer({ server: { port: 0, host: '127.0.0.1' } }); await server.listen();
  try {
    await page.setViewportSize({ width: 320, height: 740 });
    await page.goto(server.resolvedUrls!.local[0] + `e2e/fixtures/image-export.html?platform=${platform}`);
    await page.evaluate(() => { document.documentElement.style.setProperty('--app-safe-top', '32px'); document.documentElement.style.setProperty('--app-safe-bottom', '20px'); });
    const opener = page.getByRole('button', { name: '说明', exact: true }); await opener.click();
    const dialog = page.getByRole('dialog', { name: '图片预览', exact: true });
    const save = dialog.getByRole('button', { name: '保存到手机', exact: true }), share = dialog.getByRole('button', { name: '分享图片', exact: true }), close = dialog.getByRole('button', { name: '关闭', exact: true });
    // macOS WebKit uses Option+Tab for all controls with default OS keyboard settings.
    const next = browserName === 'webkit' && process.platform === 'darwin' ? 'Alt+Tab' : 'Tab';
    const previous = browserName === 'webkit' && process.platform === 'darwin' ? 'Alt+Shift+Tab' : 'Shift+Tab';
    // The viewer opens on its passive title (October 23 contract); Tab reaches Close first.
    await expect(dialog.locator('.image-preview-title')).toBeFocused();
    await page.keyboard.press(next); await expect(close).toBeFocused();
    for (const button of [save, share, close]) { await expect(button).toBeInViewport(); const box = (await button.boundingBox())!; expect(box.y).toBeGreaterThanOrEqual(32); expect(box.height).toBeGreaterThanOrEqual(44); }
    await page.screenshot({ path: info.outputPath(`image-preview-${platform}-phone.png`) });
    await page.keyboard.press(next); await expect(save).toBeFocused();
    await page.keyboard.press(previous); await expect(close).toBeFocused();
    await page.keyboard.press(previous); await expect(dialog.getByRole('button', { name: '放大图片', exact: true })).toBeFocused();
    await page.keyboard.press(next); await expect(close).toBeFocused();
    // Icon controls keep their accessible names and usable hit areas without
    // turning translated labels into a second row over a phone's picture.
    expect((await dialog.locator('header').boundingBox())!.height).toBeLessThanOrEqual(32 + 64);
    expect((await dialog.getByLabel('完整图片', { exact: true }).boundingBox())!.height).toBe(740);
    for (const button of [save, share, close]) expect((await button.boundingBox())!.width).toBe(44);
    expect(await dialog.evaluate(node => getComputedStyle(node).backgroundColor)).toBe('rgb(16, 17, 19)');
    await save.click(); await expect(save).toBeDisabled(); await expect(share).toBeDisabled();
    await expect.poll(() => page.evaluate(() => (window as any).imageExport.saved.length)).toBe(1);
    expect(await page.evaluate(() => (window as any).imageExport.saved[0])).toEqual({ uri: expect.stringMatching(/\/说明\.png$/), mime: 'image/png' });
    expect(await page.evaluate(() => (window as any).imageExport.bytes)).toEqual([...Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64')]);
    // Closing/reopening cannot dispatch another save; only a native receipt says saved.
    await close.click(); await opener.click(); await expect(save).toBeDisabled();
    await page.evaluate(() => (window as any).imageExport.release({ saved: true, location: 'Download/TaroBird/说明.png' }));
    await expect(dialog.locator('header').getByRole('status')).toHaveText('已保存到 Download/TaroBird/说明.png'); await expect(save).toBeEnabled();
    expect(await page.evaluate(() => (window as any).imageExport.shared.length)).toBe(0);
    await page.evaluate(() => { (window as any).imageExport.mode = 'fail'; }); await save.click();
    await expect(dialog.locator('header').getByRole('alert')).toContainText('保存失败'); await expect(save).toBeEnabled();
    await page.evaluate(() => { (window as any).imageExport.mode = 'cancel'; }); await save.click();
    await expect(dialog.locator('header').getByRole('status')).toHaveText('已取消保存');
    await share.click(); await expect(dialog.locator('header').getByRole('status')).toHaveText('已关闭系统分享');
    await page.evaluate(() => { (window as any).imageExport.mode = 'success'; }); await share.click();
    await expect(dialog.locator('header').getByRole('status')).toHaveText('已交给系统分享');
    // Rotated phone keeps controls inside the safe area, over the full canvas.
    await page.setViewportSize({ width: 844, height: 390 });
    for (const button of [save, share, close]) await expect(button).toBeInViewport();
    const image = dialog.getByLabel('完整图片');
    expect((await image.boundingBox())!.y).toBe(0);
    expect((await image.boundingBox())!.height).toBe(390);
    await page.screenshot({ path: info.outputPath(`image-export-${platform}-landscape.png`) });
    expect(await page.evaluate(() => {
      const fn = (window as any).imageExport.filename;
      return [fn('../../photo.jpg', 'image/png'), fn('图'.repeat(100), 'image/webp'), fn('', 'image/jpeg')];
    })).toEqual(['photo.png', '图'.repeat(70) + '.webp', 'attachment.jpg']);
    await page.keyboard.press('Escape'); await expect(dialog).toHaveCount(0); await expect(opener).toBeFocused();
    await page.setViewportSize({ width: 320, height: 740 });
    await page.evaluate(() => (window as any).imageExport.setLocale('en')); await opener.click();
    const english = page.getByRole('dialog', { name: 'Image preview', exact: true });
    for (const button of await english.locator('header button').all()) {
      await expect(button).toBeInViewport();
      const box = (await button.boundingBox())!; expect(box.x).toBeGreaterThanOrEqual(0); expect(box.x + box.width).toBeLessThanOrEqual(320);
    }
  } finally { await page.close(); await server.close(); }
});
