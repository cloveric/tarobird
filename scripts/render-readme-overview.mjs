// Compose the opening overview from actual, separately captured UI sequences.
// Usage: DEMO_KEEP=/private/.noindex/recordings node scripts/render-readme-overview.mjs
import { chromium } from '../client/node_modules/@playwright/test/index.mjs';
import { mkdtemp,readFile,writeFile,copyFile,rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import { captureProvenance } from './readme-provenance.mjs';
const root=fileURLToPath(new URL('../',import.meta.url)), output=path.join(root,'assets/product'),source=process.env.DEMO_KEEP;
if(!source?.includes('.noindex/'))throw new Error('DEMO_KEEP must be an isolated raw recording directory');
const run=promisify(execFile),hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const chapters=[
 ['inbox-demo','桌面与手机 · 按对话或 Bot 整理','Desktop and phone · Organize by chat or Bot',0,14,'crop=iw:ih-48:0:48,'],
 ['adhd-demo','ADHD · 多个对话，同时跟进','ADHD · Keep several conversations in view.',0,9.5,''],
 ['agent-bus-demo','Agent Bus · 把工作交给团队','Agent Bus · Put your team to work.',0,7,''],
 ['browser-demo','工作台 · 打开网页，阅读资料','Workbench · Open a webpage and explore.',0,9,''],
 ['canvas-demo','画布 · 选中文字，继续修改','Canvas · Select the text. Make it yours.',0,9,''],
 ['workbench-tools-demo','侧边工作台 · 白板与笔记','Side panel · Whiteboard and notes',0,6.6,''],
 ['screen-demo','屏幕控制 · 查看与接管','Screen control · View and interact.',0,4.3,''],
 ['chancellor-demo','幕僚长 · 跟进每张工单','Chancellor · Follow every ticket.',0,3.8,''],
];
const browser=await chromium.launch({headless:true}),images=[];
try{
 for(const locale of ['zh','en']){
  const work=await mkdtemp(path.join(os.tmpdir(),'readme-overview-')),page=await browser.newPage({viewport:{width:1280,height:72},deviceScaleFactor:1});
  try{
   const scenes=[];let start=0;
   for(const [index,[stem,cn,en,offset,wanted,crop]] of chapters.entries()){
    const input=path.join(source,`${stem}-${locale}.mp4`),bytes=await readFile(input);
    const probe=JSON.parse((await run('ffprobe',['-v','error','-show_entries','format=duration','-of','json',input])).stdout);
    const duration=Math.floor(Math.min(wanted,Number(probe.format.duration)-offset)*8)/8;
    if(duration<1)throw new Error(`Short overview source: ${stem}`);
    const label=locale==='zh'?cn:en,caption=path.join(work,`caption-${index}.png`),clip=path.join(work,`clip-${index}.mp4`);
    await page.setContent(`<style>*{box-sizing:border-box}body{margin:0;background:#f3f2f0;color:#302e2b;font-family:Arial,'PingFang SC',sans-serif;display:flex;align-items:center;gap:18px;padding:0 32px;height:72px}small{font:13px monospace;color:#8c8880}strong{font-size:24px;font-weight:600;letter-spacing:-.4px}span{margin-left:auto;font-size:13px;color:#77746e}</style><small>${String(index+1).padStart(2,'0')} / ${String(chapters.length).padStart(2,'0')}</small><strong>${label}</strong><span>TaroBird</span>`);
    await page.evaluate(()=>document.fonts.ready);await page.screenshot({path:caption});
    await run('ffmpeg',['-y','-v','error','-ss',String(offset),'-i',input,'-i',caption,'-filter_complex',`[0:v]${crop}fps=8,scale=1248:768:force_original_aspect_ratio=decrease:force_divisible_by=2:flags=lanczos,pad=1280:864:(ow-iw)/2:72+(768-ih)/2:color=0xf3f2f0,setsar=1[v];[v][1:v]overlay=0:0:shortest=0[out]`,'-map','[out]','-t',String(duration),'-an','-c:v','libx264','-crf','18','-pix_fmt','yuv420p',clip],{maxBuffer:10*1024*1024});
    scenes.push({label,start,duration,source:`${stem}-${locale}.gif`,sourceSha256:hash(await readFile(path.join(output,`${stem}-${locale}.gif`))),recordingSha256:hash(bytes),recordingOffset:offset});start+=duration;
   }
   await writeFile(path.join(work,'clips.txt'),chapters.map((_,i)=>`file 'clip-${i}.mp4'`).join('\n')+'\n');
   const movie=path.join(work,'overview.mp4');
   await run('ffmpeg',['-y','-v','error','-f','concat','-safe','0','-i',path.join(work,'clips.txt'),'-c','copy','-movflags','+faststart',movie]);
   const palette=path.join(work,'palette.png'),file=`demo-${locale}.gif`;
   await run('ffmpeg',['-y','-v','error','-i',movie,'-vf','palettegen=max_colors=192:stats_mode=diff',palette]);
   await run('ffmpeg',['-y','-v','error','-i',movie,'-i',palette,'-lavfi','paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle','-loop','0',path.join(output,file)]);
   await copyFile(movie,path.join(source,`overview-${locale}.mp4`));
   const bytes=await readFile(path.join(output,file));images.push({file,locale,duration:start,fps:8,size:{width:1280,height:864},scenes,bytes:bytes.length,sha256:hash(bytes)});
   console.log(`Composed ${file}: ${start}s, ${(bytes.length/1048576).toFixed(1)} MiB`);
  }finally{await page.close();await rm(work,{recursive:true,force:true});}
 }
 await writeFile(path.join(output,'demo-capture.json'),JSON.stringify({...await captureProvenance(root),captured:new Date().toISOString(),source:'Overview assembled from the actual UI recordings referenced in each scene. Synthetic conversations and workflow states; native browser uses an isolated Electron harness and a fictional local website; remote screen data and connection are simulated. No model execution, real repository push, installed-App or physical-device acceptance.',images},null,2)+'\n');
}finally{await browser.close();}
