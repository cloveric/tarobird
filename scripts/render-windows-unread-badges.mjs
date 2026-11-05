// Build-time only. Rasterize the existing OFL-licensed Sarasa font once so
// taskbar numbers do not depend on installed fonts or a live renderer.
import { chromium } from '../client/node_modules/@playwright/test/index.mjs';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const font = await readFile(new URL('../client/src/assets/fonts/sarasa-term-sc/SarasaTermSC-SemiBold.woff2', import.meta.url));
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  const png = await page.evaluate(async encoded => {
    const face = new FontFace('TaskbarNumbers', `url(data:font/woff2;base64,${encoded})`, { weight: '600' });
    document.fonts.add(await face.load());
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 640;
    const ctx = canvas.getContext('2d');
    for (let index = 0; index < 100; index++) {
      const label = index === 99 ? '99+' : String(index + 1);
      ctx.save(); ctx.translate(index % 10 * 64, Math.floor(index / 10) * 64); ctx.scale(4, 4);
      ctx.beginPath(); ctx.arc(8, 8, 7.5, 0, Math.PI * 2);
      ctx.fillStyle = '#DC303C'; ctx.fill();
      ctx.strokeStyle = '#FFFFFF'; ctx.lineWidth = 0.55; ctx.stroke();
      ctx.fillStyle = '#FFFFFF'; ctx.textAlign = 'center';
      ctx.font = `600 ${label.length === 1 ? 11.5 : label.length === 2 ? 9.5 : 7}px TaskbarNumbers`;
      const metrics = ctx.measureText(label);
      ctx.fillText(label, 8, 8 + (metrics.actualBoundingBoxAscent - metrics.actualBoundingBoxDescent) / 2);
      ctx.restore();
    }
    return canvas.toDataURL('image/png').split(',')[1];
  }, font.toString('base64'));
  const output = new URL('../client/electron/windows-unread-badges.png', import.meta.url);
  await writeFile(output, Buffer.from(png, 'base64'));
  console.log(fileURLToPath(output));
} finally { await browser.close(); }
