// Compose documentation artwork from the phoenix brand master and real UI captures.
import { chromium } from '../client/node_modules/@playwright/test/index.mjs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { frameReadmeCapture } from './readme-frame.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
// No flag renders everything. --covers-only: the two README covers.
// --products-only: workspace, phone-pair and themes compositions.
const only = process.argv[2];
if (only && only !== '--covers-only' && only !== '--products-only') throw new Error(`Unknown option: ${only}`);
const data = async (file, mime = 'image/png') => `data:${mime};base64,${(await readFile(path.join(root, file))).toString('base64')}`;
const logo = await data('assets/brand/tarobot-tray-master.png');
const font = async (name, file) => `@font-face{font-family:${name};src:url('${await data('assets/product/fonts/'+file,'font/ttf')}')}`;
const fonts = await font('Brand','BricolageGrotesque-Bold.ttf') + await font('Body','InstrumentSans-Regular.ttf') + await font('Mono','IBMPlexMono-Regular.ttf');
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ deviceScaleFactor: 1 });
async function render(file, width, height, body, css = '') {
 await page.setViewportSize({ width, height });
 await page.setContent(`<!doctype html><html><meta charset="utf-8"><style>${fonts}*{box-sizing:border-box}html,body{margin:0;width:100%;height:100%;overflow:hidden}body{font-family:Body,"PingFang SC",sans-serif;color:#292929}img{display:block} ${css}</style>${body}</html>`);
 await page.evaluate(async () => { await document.fonts.ready; await Promise.all([...document.images].map(img=>img.decode())); });
 await page.screenshot({ path: path.join(root,file), animations:'disabled' });
}
try {
 for (const locale of ['en','zh']) {
  const zh = locale === 'zh';
  if (only !== '--products-only') await render(`assets/tarobot-cover${zh?'-zh':''}.png`,1600,500,`
   <main class="cover"><section class="copy"><p class="eyebrow"><i></i>YOUR HOST. YOUR AGENTS. YOUR SPACE.</p><h1>TaroBird<span>.</span></h1><p class="tagline">${zh?'和你的 AI 搭档，随时接着聊。':'Your agents. One conversation away.'}</p><p class="engines">Codex<span>·</span>Claude Code<span>·</span>Kimi Code<span>·</span>DeepSeek Harness<span>·</span>Antigravity</p></section><img class="mascot" src="${logo}"><div class="edge">DESKTOP + MOBILE</div></main>`,
   `.cover{position:relative;width:100%;height:100%;border-radius:28px;background:linear-gradient(115deg,#faf9f7 0%,#f2f0ed 52%,#e7e2dc 100%);overflow:hidden}.copy{position:absolute;top:58px;left:76px}.eyebrow{margin:0;display:flex;align-items:center;gap:12px;font:13px Mono;letter-spacing:2px;color:#766a62}.eyebrow i{width:7px;height:7px;border-radius:50%;background:#a39b91}h1{font:700 126px/1 Brand;margin:29px 0 22px;letter-spacing:-7px;color:#2a2421}h1 span{color:#a39b91}.tagline{font-size:35px;letter-spacing:-.5px;margin:0;color:#564c46}.engines{display:flex;align-items:center;gap:17px;margin:51px 0 0;font-size:18px;color:#84786f}.engines span{color:#bcb1a7}.mascot{position:absolute;width:450px;height:450px;right:84px;top:26px;filter:drop-shadow(0 18px 16px #8a4a1c1f)}.edge{position:absolute;right:79px;bottom:39px;font:12px Mono;letter-spacing:2px;color:#8b7f76}`);
  if (only === '--covers-only') continue;
  await frameReadmeCapture(page, `desktop-${locale}.png`, `workspace-${locale}.png`, 'TAROBIRD / DESKTOP');
  for (const [source, target, label] of [['remote-screen', 'remote-screen-workspace', 'SCREEN CONTROL'], ['chancellor', 'chancellor-workspace', 'CHANCELLOR']])
   await frameReadmeCapture(page, `${source}-${locale}.png`, `${target}-${locale}.png`, `TAROBIRD / ${label}`);
  for (const [kind,label] of [['canvas','CANVAS'],['browser','BROWSER'],['whiteboard','WHITEBOARD'],['notes','NOTES'],['side','SIDE PANEL']])
   await frameReadmeCapture(page, `workbench-${kind}-${locale}.png`, `workbench-${kind}-framed-${locale}.png`, `TAROBIRD / ${label}`);
  const inbox = await data(`assets/product/mobile-${locale}.png`), chat = await data(`assets/product/mobile-chat-${locale}.png`);
  await render(`assets/product/phone-pair-${locale}.png`,1200,944,`<header><h2>${zh?'换一块屏幕，接着处理。':'A familiar place, on every screen.'}</h2><p>${zh?'按分组整理消息，在对话里继续工作。':'Organize your conversations. Pick up where you left off.'}</p></header><section><figure><img src="${inbox}"><figcaption>${zh?'消息与分组':'CONVERSATIONS & FOLDERS'}</figcaption></figure><figure><img src="${chat}"><figcaption>${zh?'随时继续对话':'PICK UP THE CONVERSATION'}</figcaption></figure></section>`,
   `body{background:#f3f2f0}header{display:none}h2{font:700 32px Brand,"PingFang SC",sans-serif;margin:0 0 10px}header p{font-size:18px;color:#6b6b6b;margin:0}section{display:flex;gap:70px;justify-content:center;padding-top:28px}figure{margin:0}figure img{width:390px;height:844px;box-sizing:content-box;border:6px solid #e5e5e5;border-radius:28px;box-shadow:0 12px 28px #0000000c}figcaption{text-align:center;font:12px Mono,"PingFang SC",sans-serif;letter-spacing:1px;color:#6b6b6b;padding-top:18px}`);
  const cli = await data(`assets/product/mono-light-${locale}.png`), pixel = await data(`assets/product/mono-dark-${locale}.png`);
  await render(`assets/product/themes-${locale}.png`,1600,600,`<header><h2>${zh?'也可以，换一种感觉。':'Make the workspace feel like you.'}</h2><p>${zh?'黑白主题，配上浅暖灰点缀。':'Monochrome, with a light warm-gray accent.'}</p></header><section><figure><figcaption><b>01</b> LIGHT</figcaption><img src="${cli}"></figure><figure><figcaption><b>02</b> DARK</figcaption><img src="${pixel}"></figure></section>`,
   `body{background:#f3f2f0;padding:36px 40px}header{display:none}h2{font:700 32px Brand,"PingFang SC",sans-serif;margin:0 0 10px}header p{font-size:18px;color:#6b6b6b;margin:0}section{display:flex;gap:24px}figure{margin:0;width:748px}figcaption{font:14px Mono;letter-spacing:1px;margin-bottom:14px;color:#666666}figcaption b{font-weight:400;color:#999999;margin-right:10px}figure img{width:748px;height:486.2px;border-radius:12px;border:1px solid #ddd9d4;box-shadow:0 8px 24px #0000000a}`);
 }
} finally { await browser.close(); }
