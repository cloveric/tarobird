// Layout only: frame four unmodified UI captures without redrawing controls.
import { chromium } from '../client/node_modules/playwright/index.mjs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';

const root = fileURLToPath(new URL('../', import.meta.url));
const data = async (file, mime = 'image/png') => `data:${mime};base64,${(await readFile(path.join(root, file))).toString('base64')}`;
const font = await data('assets/product/fonts/InstrumentSans-Regular.ttf', 'font/ttf');
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1240 }, deviceScaleFactor: 1 });
  for (const locale of ['en', 'zh']) {
    const zh = locale === 'zh';
    const panels = [
      ['groups', zh ? '一起讨论' : 'Think together', zh ? '普通群聊、并行回复、轮流讨论、独立评议' : 'Group chat, parallel replies, roundtable and review'],
      ['visual', zh ? '直接看懂结果' : 'Explore the answer', zh ? '图表、时间线、筛选与每日明细' : 'Charts, timelines, filters and daily details'],
      ['changes', zh ? '审阅本轮改动' : 'Review what changed', zh ? '逐行查看差异，把批注交给 Bot' : 'Read the diff and send your notes to the Bot'],
      ['voice', zh ? '按需配置语音' : 'Choose how to transcribe', zh ? '全部本地、全部云端，或按时长选择' : 'Local, cloud or automatic by duration'],
    ];
    const cards = await Promise.all(panels.map(async ([kind, title, subtitle], i) => `<article><header><span class="number">0${i + 1}</span><div><h2>${title}</h2><p>${subtitle}</p></div></header><div class="screen"><img alt="${title}" src="${await data(`assets/product/feature-${kind}-${locale}.png`)}"></div></article>`));
    await page.setContent(`<!doctype html><html lang="${zh ? 'zh-CN' : 'en'}"><meta charset="utf-8"><style>
      @font-face{font-family:Body;src:url('${font}')}
      *{box-sizing:border-box}html,body{margin:0}body{width:1600px;padding:32px;background:#f3f2f0;color:#292929;font-family:Body,"PingFang SC",sans-serif}
      .intro{display:flex;align-items:center;justify-content:space-between;gap:24px;height:44px;padding:4px 0 0;align-items:flex-start}.intro h1{font-size:13px;letter-spacing:1.6px;font-weight:400;color:#81776f;margin:0}.intro p{font-size:16px;color:#6b6b6b;margin:0}
      main{display:grid;grid-template-columns:1fr 1fr;gap:24px}article{border:1px solid #ddd9d4;border-radius:18px;background:white;overflow:hidden;padding:22px}
      article header{display:flex;align-items:flex-start;gap:14px;margin-bottom:18px;min-height:65px}.number{font-size:17px;line-height:32px;color:#8f877d;font-variant-numeric:tabular-nums}h2{font-size:27px;font-weight:600;letter-spacing:-.3px;margin:0 0 7px}article p{font-size:17px;color:#6b6b6b;margin:0;line-height:1.4}
      .screen{height:455px;display:flex;align-items:center;justify-content:center;overflow:hidden}img{display:block;max-width:100%;max-height:100%;width:auto;height:auto;border:1px solid #ddd9d4;border-radius:9px}
      footer{font-size:14px;color:#6b6b6b;display:flex;justify-content:space-between;gap:24px;padding:21px 4px 0}
    </style><div class="intro"><h1>TAROBIRD / CONVERSATION TOOLS</h1></div><main>${cards.join('')}</main><footer><span>${zh ? '真实界面 · 独立演示数据' : 'Actual UI · Isolated example data'}</span></footer></html>`);
    await page.evaluate(async () => { await document.fonts.ready; await Promise.all([...document.images].map(img => img.decode())); });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    assert.equal(await page.locator('img').count(), 4);
    await page.screenshot({ path: path.join(root, `assets/product/features-${locale}.png`), fullPage: true, animations: 'disabled' });
    console.log(`Composed features-${locale}.png`);
  }
} finally { await browser.close(); }
