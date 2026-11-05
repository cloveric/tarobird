// Documentation illustration only: synthetic roles, no live Host or model calls.
import { chromium } from '../client/node_modules/@playwright/test/index.mjs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = process.argv[2] ? path.resolve(process.argv[2]) : path.join(root, 'assets/product');
const font = (await readFile(path.join(root, 'assets/product/fonts/InstrumentSans-Regular.ttf'))).toString('base64');
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1120, height: 780 }, deviceScaleFactor: 2 });
const escape = value => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;');
const text = (x, y, value, size = 22, color = '#302b27', weight = 400, extra = '') =>
  `<text x="${x}" y="${y}" font-size="${size}" fill="${color}" font-weight="${weight}" ${extra}>${escape(value)}</text>`;
const box = (x, y, w, h, fill = '#ffffff', radius = 20, stroke = '#ded9d2') =>
  `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${radius}" fill="${fill}" stroke="${stroke}"/>`;
const paths = {
  research: '<circle cx="10" cy="10" r="6"/><path d="m15 15 6 6M7 10h6M10 7v6"/>',
  writing: '<path d="m5 16-1 5 5-1L21 8l-4-4ZM14 7l4 4M4 4h7M4 8h4"/>',
  review: '<path d="M7 3h10l4 4v14H3V3h4M15 3v6h6M7 14l3 3 6-6"/>',
  desktop: '<rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/>',
  server: '<rect x="4" y="2" width="16" height="20" rx="3"/><path d="M8 7h8M8 12h8M8 17h2"/>',
  code: '<path d="m8 5-6 7 6 7M16 5l6 7-6 7M14 3l-4 18"/>',
};
const icon = (kind, x, y, color = '#76695e', scale = 1) => `<g transform="translate(${x} ${y}) scale(${scale})" fill="none" stroke="${color}" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${paths[kind]}</g>`;

try {
  for (const locale of ['en', 'zh']) {
    const zh = locale === 'zh';
    const word = (en, cn) => zh ? cn : en;
    const role = (x, title, detail, kind, fill, stroke) => box(x, 244, 190, 116, '#fff', 16, '#e7e2dc')
      + box(x + 18, 258, 34, 34, fill, 10, fill) + icon(kind, x + 23, 263, stroke)
      + text(x + 18, 318, title, 23, '#302b27', 600)
      + text(x + 18, 344, detail, 19, '#786e66');
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1120" height="780" viewBox="0 0 1120 780" role="img" aria-labelledby="title desc">
      <title id="title">${word('Bot collaboration within and across hosts', '同机协作与跨主机 Bot 通信')}</title>
      <desc id="desc">${word('Research and writing Bots work on a Mac. The writing Bot sends tasks and files to a review Bot on Windows and receives results. Another computer can join with its own Bots. Communication requires permission; data remains on the owning host.', 'Mac 上的研究和写作 Bot 相互协作，写作 Bot 向 Windows 上的审阅 Bot 传递任务、文件并收取结果；另一台电脑可带着自己的 Bot 加入。通信需要授权，数据仍留在所属主机。')}</desc>
      <defs>
        <marker id="send" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M1 1 9 5 1 9" fill="none" stroke="#aa7955" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></marker>
        <marker id="reply" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M1 1 9 5 1 9" fill="none" stroke="#71866e" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></marker>
        <marker id="join" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M1 1 9 5 1 9" fill="none" stroke="#8e857b" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></marker>
      </defs>
      ${box(0, 0, 1120, 780, '#f8f7f4', 24, '#f8f7f4')}
      ${text(48, 39, 'TAROBIRD / BOT NETWORK', 15, '#8b7e71', 600, 'letter-spacing="2"')}
      ${text(48, 88, word('Different computers. One connected team.', '不同电脑上的 Bot，一起完成任务。'), 36, '#302b27', 600)}
      ${box(32, 120, 1056, 424, '#f0ede7', 24, '#e0dad1')}
      ${text(56, 153, word('YOUR PRIVATE NETWORK', '你的私有网络'), 17, '#837566', 600, 'letter-spacing="1"')}
      ${box(56, 176, 510, 212, '#ffffff', 20)}
      ${icon('desktop', 80, 196, '#71675e', 1.2)}
      ${text(122, 218, word('Mac · Host A', 'Mac · 主机 A'), 25, '#302b27', 600)}
      ${text(542, 216, word('Same-host collaboration', '同机协作'), 17, '#8b7e71', 400, 'text-anchor="end"')}
      ${role(80, word('Research Bot', '研究 Bot'), word('Gather findings', '整理资料'), 'research', '#eee9f4', '#87739b')}
      ${role(352, word('Writing Bot', '写作 Bot'), word('Prepare a draft', '撰写初稿'), 'writing', '#f4eadc', '#a17a4c')}
      <path d="M282 302H338" fill="none" stroke="#aa7955" stroke-width="2.5" marker-end="url(#send)"/>
      ${box(678, 176, 354, 212, '#ffffff', 20)}
      ${icon('desktop', 702, 196, '#71675e', 1.2)}
      ${text(744, 218, word('Windows · Host B', 'Windows · 主机 B'), 25, '#302b27', 600)}
      ${box(702, 244, 306, 116, '#fff', 16, '#e7e2dc')}
      ${box(720, 270, 48, 48, '#e8eee4', 14, '#e8eee4')}${icon('review', 732, 282, '#6f8766')}
      ${text(786, 291, word('Review Bot', '审阅 Bot'), 25, '#302b27', 600)}
      ${text(786, 323, word('Check and refine', '审阅并完善'), 19, '#786e66')}
      <path d="M448 360V410Q448 430 468 430H800Q820 430 820 410V366" fill="none" stroke="#aa7955" stroke-width="2.5" marker-end="url(#send)"/>
      ${box(520, 409, 244, 40, '#f0ede7', 12, '#f0ede7')}
      ${text(642, 436, word('Task + files', '跨主机：任务 + 文件'), 22, '#9b6c48', 600, 'text-anchor="middle"')}
      <path d="M926 360V468Q926 490 904 490H422Q400 490 400 468V366" fill="none" stroke="#71866e" stroke-width="2.5" marker-end="url(#reply)"/>
      ${box(520, 469, 244, 40, '#f0ede7', 12, '#f0ede7')}
      ${text(642, 496, word('Feedback + results', '回复 + 交付物'), 22, '#647a60', 600, 'text-anchor="middle"')}
      <path d="M302 594V552" fill="none" stroke="#8e857b" stroke-width="2" stroke-dasharray="4 5" marker-end="url(#join)"/>
      ${box(56, 594, 510, 120, '#ffffff', 20)}
      ${box(80, 620, 58, 58, '#e8edf0', 16, '#e8edf0')}${icon('server', 96, 636, '#738794', 1.1)}
      ${text(156, 637, word('Another computer', '另一台电脑'), 25, '#302b27', 600)}
      ${text(156, 672, word('Brings its own Bots', '带着自己的 Bot 加入'), 22, '#786e66')}
      ${box(460, 634, 38, 38, '#f4eadc', 12, '#f4eadc')}${icon('code', 467, 641, '#a17a4c')}
      ${box(506, 634, 38, 38, '#eee9f4', 12, '#eee9f4')}${icon('research', 513, 641, '#87739b')}
      ${text(620, 621, word('Grow your network', '让更多主机加入'), 27, '#302b27', 600)}
      ${text(620, 654, word('Pair the computer, then confirm joining.', '先配对，再确认加入网络。'), 20, '#786e66')}
      ${text(620, 686, word('Authorize Bot communication separately.', 'Bot 之间的通信需单独授权。'), 20, '#786e66')}
      ${text(56, 752, word('Illustrative workflow · Bots, conversations and files stay with their own host.', '协作关系示意 · Bot、对话和文件仍保留在各自所属的主机。'), 19, '#8b7e71')}
    </svg>`;
    await page.setContent(`<meta charset="utf-8"><style>@font-face{font-family:Body;src:url(data:font/ttf;base64,${font})}body{margin:0}svg{display:block;font-family:Body,"PingFang SC",sans-serif}</style>${svg}`);
    await page.evaluate(() => document.fonts.ready);
    const overflow = await page.locator('svg text').evaluateAll(nodes => nodes.filter(node => {
      const r = node.getBoundingClientRect(); return r.left < 0 || r.right > 1120 || r.top < 0 || r.bottom > 780;
    }).map(node => node.textContent));
    if (overflow.length) throw new Error(`Text outside illustration: ${overflow.join(', ')}`);
    await page.screenshot({ path: path.join(output, `bot-network-${locale}.png`), animations: 'disabled' });
    console.log(`Rendered bot-network-${locale}.png (2240 x 1560)`);
  }
} finally { await browser.close(); }
