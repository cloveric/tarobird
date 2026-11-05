// Authored documentation diagram. Fictional roles; no Host or model invocation.
import { chromium } from '../client/node_modules/@playwright/test/index.mjs';
import { mkdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root = fileURLToPath(new URL('../', import.meta.url));
const output = path.resolve(process.argv[2] ?? path.join(root, 'assets/product'));
await mkdir(output, { recursive: true });
const font = (await readFile(path.join(root, 'assets/product/fonts/InstrumentSans-Regular.ttf'))).toString('base64');
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1120, height: 920 }, deviceScaleFactor: 2 });
const esc = s => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;');
const text = (x,y,s,size=20,color='#70685f',weight=400,extra='') => `<text x="${x}" y="${y}" font-size="${size}" fill="${color}" font-weight="${weight}" ${extra}>${esc(s)}</text>`;
const rect = (x,y,w,h,fill='#fff',r=20,stroke='#ded8cf') => `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" fill="${fill}" stroke="${stroke}"/>`;
const icon = (x,y,kind,color='#817166') => `<g transform="translate(${x} ${y})" fill="none" stroke="${color}" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${({computer:'<rect x="1" y="2" width="24" height="17" rx="3"/><path d="M8 24h10M13 19v5"/>',bot:'<rect x="2" y="6" width="22" height="18" rx="6"/><path d="M13 2v4M8 14h1M17 14h1M9 19h8"/>',code:'<path d="m8 5-7 8 7 8m10-16 7 8-7 8M15 2l-4 22"/>',search:'<circle cx="11" cy="11" r="8"/><path d="m17 17 8 8M7 11h8"/>',check:'<path d="m4 13 6 6L23 6"/>',file:'<path d="M5 2h12l5 5v18H5ZM16 2v7h6M9 14h9M9 19h7"/>'})[kind]}</g>`;
const tag=(x,y,label,fill='#eee8df',color='#897055')=>rect(x,y,172,37,fill,11,fill)+text(x+86,y+25,label,17,color,500,'text-anchor="middle"');
try {
 for (const locale of ['en','zh']) {
  const zh=locale==='zh', w=(en,cn)=>zh?cn:en;
  const role=(x,y,name,task,kind,tint,color)=>rect(x,y,196,106,'#fff',14,'#e8e3dc')+rect(x+14,y+16,32,32,tint,10,tint)+icon(x+17,y+19,kind,color)+text(x+14,y+72,name,21,'#302b27',600)+text(x+14,y+94,task,16);
  const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="1120" height="920" viewBox="0 0 1120 920" role="img" aria-labelledby="title desc">
  <title id="title">${w('One Bot coordinates work across computers','一个 Bot 协调，多台电脑分工')}</title><desc id="desc">${w('An illustrative coordinator on a Mac delegates tasks to Windows and server Bots, which return results. Authorized peers can also hand work to one another. This is a messaging pattern, not a distributed Agent Bus.','协作方式示意：Mac 上的协调 Bot 把任务交给 Windows 与服务器上的 Bot，收回结果；已授权的对端 Bot 也可以相互接力。这是消息协作方式，并非跨主机 Agent Bus。')}</desc>
  <defs>${[['task','#a87a56'],['result','#788b76'],['peer','#8a7c99']].map(([id,c])=>`<marker id="${id}" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M2 2 8 5 2 8" fill="none" stroke="${c}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></marker>`).join('')}</defs>
  ${rect(0,0,1120,920,'#f8f7f4',24,'#f8f7f4')}
  ${text(48,42,'TAROBIRD / CONNECTED BOTS',14,'#8b7e71',600,'letter-spacing="2"')}
  ${text(48,94,w('One goal. A team across your computers.','一个目标，让不同电脑上的 Bot 一起完成。'),35,'#302b27',600)}
  ${text(48,132,w('Delegate tasks, exchange files, bring the results back.','分配任务、交换文件，再把结果汇总到同一条对话。'),22)}
  ${rect(32,165,1056,622,'#f0ede7',24,'#e0dad1')}
  ${text(56,196,w('YOUR PRIVATE NETWORK','你的私有网络'),14,'#8b7e71',600,'letter-spacing="1.5"')}
  ${rect(348,214,424,172)}
  ${icon(374,236,'computer')}${text(416,256,w('Mac · Coordination','Mac · 统筹任务'),22,'#302b27',600)}
  ${rect(374,276,372,86,'#fbf9f5',14,'#ebe4da')}${icon(391,292,'bot','#9b7651')}
  ${text(436,310,w('Coordinator Bot','协调 Bot'),24,'#302b27',600)}
  ${text(436,341,w('Your plan · collected results','指定分工 · 汇总结果'),19)}
  <path d="M420 386V408Q420 424 404 424H300Q284 424 284 440V460" fill="none" stroke="#a87a56" stroke-width="2.5" marker-end="url(#task)"/>
  <path d="M700 386V408Q700 424 716 424H820Q836 424 836 440V460" fill="none" stroke="#a87a56" stroke-width="2.5" marker-end="url(#task)"/>
  <path d="M202 460V428Q202 402 228 402H332Q356 402 356 380" fill="none" stroke="#788b76" stroke-width="2" stroke-dasharray="5 5" marker-end="url(#result)"/>
  <path d="M918 460V428Q918 402 892 402H788Q764 402 764 380" fill="none" stroke="#788b76" stroke-width="2" stroke-dasharray="5 5" marker-end="url(#result)"/>
  ${tag(64,267,w('Tasks + files','任务 + 文件'),'#f4eadc','#996c48')}
  ${tag(884,267,w('Replies + results','回复 + 交付物'),'#e6ece2','#667e61')}
  ${text(64,325,w('One Bot is your','由一个 Bot'),19)}${text(64,352,w('coordination point.','作为统一协调入口。'),19)}
  ${text(884,325,w('Each host runs','每台主机'),19)}${text(884,352,w('its own work.','执行自己的任务。'),19)}
  ${rect(56,464,488,228)}${icon(80,485,'computer')}${text(121,506,w('Windows · Build & review','Windows · 构建与复核'),24,'#302b27',600)}
  ${role(80,529,w('Build Bot','构建 Bot'),w('Build & test locally','在本机构建、测试'),'code','#eee9f4','#8b789c')}
  ${role(324,529,w('Review Bot','审阅 Bot'),w('Review the changes','检查改动与结果'),'check','#e8eee4','#71886a')}
  <path d="M286 581H312" fill="none" stroke="#958575" stroke-width="2" marker-end="url(#task)"/>
  ${text(80,670,w('Local Bots can hand work to each other.','本机 Bot 之间也能分工接力。'),18)}
  ${rect(576,464,488,228)}${icon(600,485,'computer')}${text(641,506,w('Server · Research & data','服务器 · 资料与数据'),24,'#302b27',600)}
  ${role(600,529,w('Research Bot','研究 Bot'),w('Gather context','整理背景资料'),'search','#e9eef1','#748b98')}
  ${role(844,529,w('Analysis Bot','分析 Bot'),w('Process data locally','在本机处理数据'),'file','#f4eadc','#a07d50')}
  <path d="M806 581H832" fill="none" stroke="#958575" stroke-width="2" marker-end="url(#task)"/>
  ${text(600,670,w('Add another host with its own Bots.','新主机可以带着自己的 Bot 加入。'),18)}
  <path d="M300 692V726Q300 744 318 744H802Q820 744 820 726V698" fill="none" stroke="#8a7c99" stroke-width="2" marker-end="url(#peer)"/>
  ${rect(352,726,416,36,'#f0ede7',10,'#f0ede7')}${text(560,751,w('Peer handoffs · separately authorized','机器间相互接力 · 按方向单独授权'),19,'#7d6b8d',500,'text-anchor="middle"')}
  ${text(56,829,w('Choose who can send to whom.','由你决定，谁可以给谁发任务。'),24,'#302b27',600)}
  ${text(56,864,w('Bots execute on their owning hosts; results return through collaboration messages.','Bot 在所属主机上执行；结果通过协作消息回传。'),20)}
  ${text(56,898,w('Illustrative messaging pattern · Agent Bus and Chancellor ticket dispatch remain host-local.','消息协作方式示意 · Agent Bus 与幕僚长工单派发仍限定在本机。'),16,'#8b7e71')}
  </svg>`;
  await page.setContent(`<meta charset="utf-8"><style>@font-face{font-family:Body;src:url(data:font/ttf;base64,${font})}body{margin:0}svg{display:block;font-family:Body,"PingFang SC",sans-serif}</style>${svg}`);
  await page.evaluate(()=>document.fonts.ready);
  const outside=await page.locator('svg text').evaluateAll(nodes=>nodes.filter(n=>{const r=n.getBoundingClientRect();return r.left<0||r.right>1120||r.top<0||r.bottom>920}).map(n=>n.textContent));
  if(outside.length)throw new Error(`Text outside diagram: ${outside.join(', ')}`);
  await page.screenshot({path:path.join(output,`bot-team-${locale}.png`),animations:'disabled'});
  console.log(`Rendered bot-team-${locale}.png (2240 x 1840)`);
 }
} finally {await browser.close();}
