// Production remote-screen component; simulated transport and demo frame only.
import { chromium, expect } from '../client/node_modules/@playwright/test/index.mjs';
import { createServer } from '../client/node_modules/vite/dist/node/index.js';
import { mkdtemp, readFile, writeFile, rm, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { captureProvenance } from './readme-provenance.mjs';
import { recordReadmeMotion } from './readme-motion.mjs';
const root = fileURLToPath(new URL('../', import.meta.url)), client = path.join(root, 'client'), output = path.join(root, 'assets/product');
const cacheDir = await mkdtemp(path.join(client, 'node_modules/.vite-readme-'));
const server = await createServer({ root: client, cacheDir, server: { host: '127.0.0.1', port: 0, strictPort: false, fs: { allow: [root, await realpath(path.join(client, 'node_modules'))] } } });
const browser = await chromium.launch({ headless: true }); const images = [], animations = [];
try {
 await server.listen();
 for (const locale of ['zh', 'en']) {
  const context = await browser.newContext({ viewport: { width: 1200, height: 540 }, deviceScaleFactor: 1.5 });
  try {
   const page = await context.newPage(); const errors = []; page.on('pageerror', error => errors.push(error.message));
   const sample = await readFile(path.join(output, `adhd-${locale}.png`));
   await page.addInitScript(data => { window.readmeScreen = data; }, { locale, image: 'data:image/png;base64,' + sample.toString('base64') });
   await page.goto(server.resolvedUrls.local[0] + 'e2e/fixtures/readme-screen.html');
   await page.getByRole('button', { name: locale === 'zh' ? '连接屏幕' : 'Connect screen', exact: true }).click();
   await expect(page.getByRole('button', { name: locale === 'zh' ? '开始控制' : 'Start control', exact: true })).toBeEnabled();
   await expect(page.locator('canvas')).toBeVisible(); await page.evaluate(() => document.fonts.ready);
   await page.mouse.move(0, 0); await page.waitForTimeout(500); expect(errors).toEqual([]);
   const file = `remote-screen-${locale}.png`; await page.locator('dialog').screenshot({ path: path.join(output, file), animations: 'disabled' });
   images.push({ file, locale, viewport: page.viewportSize(), capture: 'Complete viewer dialog, excluding the browser backdrop', sha256: createHash('sha256').update(await readFile(path.join(output, file))).digest('hex') });
   const motion = await recordReadmeMotion({ screenshot: options => page.locator('dialog').screenshot(options) }, path.join(cacheDir, `motion-${locale}`), path.join(output, `screen-demo-${locale}.gif`), async () => {
    await page.waitForTimeout(1200);
    await page.getByRole('button', { name:locale === 'zh' ? '开始控制' : 'Start control', exact:true }).click();
    await expect(page.getByRole('button', { name:locale === 'zh' ? '停止控制' : 'Stop control', exact:true })).toBeEnabled();
    await page.waitForTimeout(1800);
    await page.getByRole('button', { name:locale === 'zh' ? '停止控制' : 'Stop control', exact:true }).click();
    await expect(page.getByRole('button', { name:locale === 'zh' ? '开始控制' : 'Start control', exact:true })).toBeEnabled();
    await page.waitForTimeout(1000);
   });
   animations.push({ ...motion, locale, actions:['View screen','Start control','Stop control'], simulatedTransport:true });

  } catch (error) { console.error(await context.pages()[0]?.locator('body').innerText()); throw error; } finally { await context.close(); }
 }
 await writeFile(path.join(output, 'screen-capture.json'), JSON.stringify({ ...await captureProvenance(root), captured: new Date().toISOString(), source: 'Production RemoteScreenPanel rendered in a documentation fixture; simulated transport with the synthetic ADHD capture as its frame. No native screen capture, network connection or keyboard/mouse input.', images, animations }, null, 2) + '\n');
} finally { await browser.close(); await server.close(); await rm(cacheDir, { recursive: true, force: true }); }
