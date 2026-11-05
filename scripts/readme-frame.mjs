// Documentation framing only: retain the full capture and its aspect ratio.
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const output = fileURLToPath(new URL('../assets/product/', import.meta.url));
export async function frameReadmeCapture(page, source, target, label) {
 const bytes = await readFile(path.join(output, source));
 const imageHeight = Math.ceil(1536 * bytes.readUInt32BE(20) / bytes.readUInt32BE(16));
 await page.setViewportSize({ width: 1600, height: imageHeight + 104 });
 await page.setContent(`<!doctype html><meta charset="utf-8"><style>
  *{box-sizing:border-box}html,body{margin:0;width:100%;height:100%;overflow:hidden}
  body{padding:28px 32px 32px;background:#f3f2f0;color:#81776f}
  header{font:13px -apple-system,BlinkMacSystemFont,sans-serif;letter-spacing:1.6px;height:44px;display:flex;align-items:flex-start;padding-top:4px}
  img{display:block;width:1536px;height:auto;border-radius:12px;outline:1px solid #ddd9d4;box-shadow:0 8px 24px #00000008}
 </style><header></header><img>`);
 await page.locator('header').evaluate((node, value) => { node.textContent = value; }, label);
 await page.locator('img').evaluate(async (node, value) => { node.src = value; await node.decode(); }, `data:image/png;base64,${bytes.toString('base64')}`);
 await page.screenshot({ path: path.join(output, target), animations: 'disabled' });
}
