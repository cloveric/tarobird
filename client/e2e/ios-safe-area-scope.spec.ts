import { test, expect } from '@playwright/test';
import { createServer } from './fixtures/vite.js';
import type { ViteDevServer } from 'vite';

test.use({ hasTouch: true });
let server: ViteDevServer;
test.beforeAll(async () => { server = await createServer({ server: { host: '127.0.0.1', port: 0 } }); await server.listen(); });
test.afterAll(async () => { await server?.close(); });
test('Duo spacing does not remove the ordinary iPhone home-indicator clearance', async ({ page }) => {
  await page.goto(server.resolvedUrls!.local[0] + 'e2e/fixtures/ios-safe-area-scope.html');
  for (const [width, height] of [[390, 844], [844, 390], [440, 956], [956, 440], [466, 678], [678, 466]]) {
    await page.setViewportSize({ width: width!, height: height! });
    await expect(page.locator('.sidebar')).toHaveCSS('padding-bottom', '34px');
    await expect(page.locator('.composer-wrap')).toHaveCSS('padding-bottom', '34px');
  }
  await page.setViewportSize({ width: 951, height: 669 });
  await expect(page.locator('.sidebar')).toHaveCSS('padding-bottom', '0px');
  await expect(page.locator('.composer-wrap')).toHaveCSS('padding-bottom', '20px');
  await page.setViewportSize({ width: 430, height: 932 });
  await expect(page.locator('.sidebar')).toHaveCSS('padding-bottom', '34px');
  await expect(page.getByRole('textbox')).toHaveValue('Keep this draft');
});
