// Frame the full, unchanged documentation capture without repeating README headings.
import { chromium } from '../client/node_modules/@playwright/test/index.mjs';
import { frameReadmeCapture } from './readme-frame.mjs';
const browser = await chromium.launch({ headless: true });
try {
 const page = await browser.newPage({ deviceScaleFactor: 1 });
 for (const locale of ['en', 'zh'])
  await frameReadmeCapture(page, `agent-bus-${locale}.png`, `agent-bus-workspace-${locale}.png`, 'TAROBIRD / AGENT BUS');
} finally { await browser.close(); }
