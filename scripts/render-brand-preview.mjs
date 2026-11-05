// Reproducible brand contact sheet and GitHub social image; these are asset
// previews, not screenshots of installed/native applications.
import { chromium } from '../client/node_modules/@playwright/test/index.mjs';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root = fileURLToPath(new URL('../', import.meta.url));
const out = process.argv[2];
if (!out || !path.isAbsolute(out)) throw new Error('Pass an absolute evidence output directory');
await mkdir(out, { recursive: true });
const data = async (file, mime='image/png') => `data:${mime};base64,${(await readFile(path.join(root,file))).toString('base64')}`;
const browser=await chromium.launch({headless:true});
const page=await browser.newPage({viewport:{width:1280,height:640},deviceScaleFactor:1});
try {
 if (!process.argv.includes('--icons-only')) {
 const svg=(await readFile(path.join(root,'assets/github-banner.svg'),'utf8')).replace('brand/tarobot-tray-master.png',await data('assets/brand/tarobot-tray-master.png'));
 await page.setContent(`<style>html,body{margin:0;background:white}svg{display:block}</style>${svg}`);
 await page.evaluate(async()=>{ await document.fonts.ready; await Promise.all([...document.querySelectorAll('image')].map(el=>new Promise((resolve,reject)=>{const image=new Image();image.onload=resolve;image.onerror=reject;image.src=el.getAttribute('href');}))); });
 await page.screenshot({path:path.join(root,'assets/github-banner.png')});
 }
 const mark=await data('client/src/brand/tarobot.png'), app=await data('assets/brand/tarobot-master.png');
 const tray=await data('client/src-tauri/icons/tray-macos.png');
 const android=await data('client/android/app/src/main/res/mipmap-xxxhdpi/ic_launcher_foreground.png');
 const macSvg=(await readFile(path.join(root,'assets/brand/macos.svg'),'utf8')).replace('tarobot-master.png',app);
 const mac=`data:image/svg+xml;base64,${Buffer.from(macSvg).toString('base64')}`;
 const windows=await data('assets/brand/tarobot-windows-master.png');
 const small=[16,24,32,48,64].map(n=>`<figure><img src="${windows}" style="width:${n}px;height:${n}px"><figcaption>${n}px</figcaption></figure>`).join('');
 const markup=`<!doctype html><html lang="zh"><meta charset="utf-8"><style>*{box-sizing:border-box}body{margin:0;padding:42px;background:#faf8f5;color:#302a25;font-family:-apple-system,BlinkMacSystemFont,sans-serif}h1{font-size:27px;font-weight:650;margin:0 0 9px}p{font-size:14px;color:#8c8075;margin:0 0 28px}.grid{display:grid;grid-template-columns:repeat(4,1fr);gap:16px}.card{background:#fff;border:1px solid #eae4dc;border-radius:18px;padding:22px;min-height:224px;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:13px}.card>img{width:138px;height:138px}.label{font-size:14px;color:#73655b}.pair{display:flex;align-items:center;gap:12px}.pair img{width:100px;height:100px}.mac{background:#e8e8e8}.ios{border-radius:30px}.adaptive{background:#e3dbd5;width:140px;height:140px;border-radius:50%;position:relative;overflow:hidden}.adaptive img{width:210px;height:210px;position:absolute;left:-35px;top:-35px}.wide{grid-column:span 2;min-height:160px;align-items:stretch}.bars{display:flex;gap:12px}.bar{flex:1;display:flex;align-items:center;justify-content:center;gap:25px;padding:14px;border-radius:8px;background:#f4f3f1}.bar.dark{background:#262624;color:white}.template{height:22px;width:22px;mask:url('${tray}') center/contain no-repeat;background:currentColor}.bar small{font-size:12px}.sizes{display:flex;align-items:center;justify-content:space-around;gap:16px;min-height:70px}figure{margin:0;text-align:center}figcaption{font-size:11px;color:#8e8176;margin-top:12px}footer{font-size:12px;color:#998c80;margin-top:23px}</style><h1>TaroBird · 凤凰品牌预览</h1><p>暖浅灰近景用于启动图标；Mac 小鸟状态栏和单色图标保持独立。</p><div class="grid"><div class="card"><div class="pair"><img src="${mark}"></div><div class="label">App 内品牌图</div></div><div class="card mac"><img src="${mac}"><div class="label">macOS 图标</div></div><div class="card"><img class="ios" src="${app}"><div class="label">iPhone 图标</div></div><div class="card"><div class="adaptive"><img src="${android}"></div><div class="label">Android 自适应圆形</div></div><div class="card wide"><div class="label">Mac 状态栏 · 原生模板模式 · 22pt</div><div class="bars"><div class="bar"><span>⌁</span><i class="template"></i><small>19:41</small></div><div class="bar dark"><span>⌁</span><i class="template"></i><small>19:41</small></div></div></div><div class="card wide"><div class="label">暖浅灰小尺寸图标 · Windows</div><div class="sizes">${small}</div></div></div><footer>此图为实际生成资源的预览，不代表已安装 App 或真机验收。</footer></html>`;
 await page.setViewportSize({width:1280,height:640});
 await page.setContent(markup);
 await page.evaluate(async()=>{await document.fonts.ready;await Promise.all([...document.images].map(im=>im.decode()));});
 await page.screenshot({path:path.join(out,'brand-contact-sheet.png'),fullPage:true});
 await writeFile(path.join(out,'brand-contact-sheet.html'),markup);
} finally {await browser.close();}
